import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractSection, extractToc } from '../lib/markdown.js';
import { parseFrontmatter, asNonEmptyString } from '../lib/frontmatter.js';
import { hasPathPrefix } from '../lib/sitemap.js';
import { logger } from '../lib/logger.js';
import {
  type FumadocsSource,
  type PageContent,
  type PageSummary,
  type SearchHit,
  type SearchOptions,
  type TocEntry,
  NotFoundError,
  SourceError,
} from './types.js';

export interface LocalSourceOptions {
  /** Path to the Fumadocs project root. */
  rootDir: string;
  /** Path (absolute or relative to rootDir) to the docs content directory. Default: "content/docs". */
  contentDir?: string;
  /** URL prefix to use when reporting page URLs. Default: "/docs". */
  urlPrefix?: string;
}

interface IndexedPage {
  /** Absolute file path. */
  filePath: string;
  /** Path relative to contentDir, with extension stripped (e.g. "guides/install"). */
  slug: string;
  /** Public URL (urlPrefix + slug). */
  url: string;
  meta: Record<string, unknown>;
  /** Markdown body without frontmatter. */
  body: string;
  title: string;
  description?: string;
  toc: TocEntry[];
}

export class LocalFumadocsSource implements FumadocsSource {
  readonly label: string;
  private rootDir: string;
  private contentDir: string;
  private urlPrefix: string;
  private indexPromise: Promise<Map<string, IndexedPage>> | null = null;

  constructor(opts: LocalSourceOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    const cd = opts.contentDir ?? 'content/docs';
    this.contentDir = path.isAbsolute(cd) ? cd : path.join(this.rootDir, cd);
    this.urlPrefix = (opts.urlPrefix ?? '/docs').replace(/\/+$/, '');
    this.label = `local:${this.rootDir}`;
  }

  private async index(): Promise<Map<string, IndexedPage>> {
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex();
    }
    return this.indexPromise;
  }

  private async buildIndex(): Promise<Map<string, IndexedPage>> {
    const map = new Map<string, IndexedPage>();
    let stat;
    try {
      stat = await fs.stat(this.contentDir);
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new SourceError(
          `Local content directory not found: ${this.contentDir}. Pass --content-dir to override.`,
        );
      }
      throw new SourceError(`Failed to access local content directory: ${this.contentDir}`, err);
    }
    if (!stat.isDirectory()) {
      throw new SourceError(`Not a directory: ${this.contentDir}`);
    }
    const files = await walk(this.contentDir);
    for (const file of files) {
      if (!/\.mdx?$/i.test(file)) continue;
      const rel = path.relative(this.contentDir, file).replace(/\\/g, '/');
      let slug = rel.replace(/\.mdx?$/i, '');
      if (slug === 'index') slug = '';
      else if (slug.endsWith('/index')) slug = slug.slice(0, -'/index'.length);
      const url = slug ? `${this.urlPrefix}/${slug}` : this.urlPrefix;
      let raw: string;
      let body: string;
      let meta: Record<string, unknown>;
      try {
        raw = await fs.readFile(file, 'utf8');
        ({ content: body, data: meta } = parseFrontmatter(raw));
      } catch (err) {
        logger.warn({ err, file }, 'local: skipping page that failed to read/parse');
        continue;
      }
      const toc = extractToc(body);
      // Frontmatter is untrusted content: `meta.title`/`meta.description`
      // may be a YAML number, boolean, etc. A non-string title would
      // otherwise reach `search()`'s `.toLowerCase()` call and throw,
      // breaking search for every page (not just this one) until the
      // process restarts; `asNonEmptyString()` guards both fields so a
      // wrong-typed value falls through to the usual fallback chain
      // instead of silently propagating.
      const title =
        asNonEmptyString(meta.title) ??
        firstHeading(body) ??
        slug.split('/').pop() ??
        'Untitled';
      const description = asNonEmptyString(meta.description);
      map.set(url, {
        filePath: file,
        slug,
        url,
        meta,
        body,
        title,
        ...(description ? { description } : {}),
        toc,
      });
    }
    logger.debug({ count: map.size, dir: this.contentDir }, 'local: built page index');
    return map;
  }

  private async resolveRef(ref: string): Promise<IndexedPage> {
    const idx = await this.index();
    // Normalize: strip protocol/host, ensure leading slash, drop trailing slash.
    let r = ref.trim();
    if (/^https?:\/\//i.test(r)) {
      try {
        r = new URL(r).pathname;
      } catch {
        // ignore
      }
    }
    if (!r.startsWith('/')) r = `${this.urlPrefix}/${r}`;
    r = r.replace(/\/+$/, '');
    if (r === '') r = this.urlPrefix;
    const direct = idx.get(r);
    if (direct) return direct;
    throw new NotFoundError(`Local page not found for ref "${ref}" (looked up "${r}")`);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const idx = await this.index();
    const query = opts.query.trim().toLowerCase();
    if (!query) return [];
    const tokens = query.split(/\s+/).filter(Boolean);
    const scored: Array<{ hit: SearchHit; score: number }> = [];
    for (const page of idx.values()) {
      if (opts.tag && !matchesTag(page.meta.tag, opts.tag)) continue;
      if (opts.locale && page.meta.locale !== opts.locale) continue;
      const haystack = `${page.title}\n${page.description ?? ''}\n${page.body}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (!t) continue;
        // Title and headings are weighted more.
        if (page.title.toLowerCase().includes(t)) score += 10;
        for (const e of page.toc) {
          if (e.title.toLowerCase().includes(t)) score += 3;
        }
        const occurrences = countOccurrences(haystack, t);
        score += occurrences;
      }
      if (score > 0) {
        scored.push({
          hit: {
            url: page.url,
            title: page.title,
            ...(page.description ? { description: page.description } : {}),
            excerpt: snippet(page.body, tokens[0] ?? ''),
            score,
            ...(typeof page.meta.tag === 'string' ? { tag: page.meta.tag } : {}),
          },
          score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const limit = opts.limit ?? 10;
    return scored.slice(0, limit).map((s) => s.hit);
  }

  async listPages(prefix?: string): Promise<PageSummary[]> {
    const idx = await this.index();
    const out: PageSummary[] = [];
    for (const page of idx.values()) {
      if (prefix && !hasPathPrefix(page.url, prefix)) continue;
      out.push({
        id: page.url,
        url: page.url,
        title: page.title,
        ...(page.description ? { description: page.description } : {}),
        segments: page.url.split('/').filter(Boolean),
      });
    }
    out.sort((a, b) => a.url.localeCompare(b.url));
    return out;
  }

  async getPage(ref: string): Promise<PageContent> {
    const page = await this.resolveRef(ref);
    return {
      id: page.url,
      url: page.url,
      title: page.title,
      ...(page.description ? { description: page.description } : {}),
      segments: page.url.split('/').filter(Boolean),
      markdown: page.body,
      meta: page.meta,
      toc: page.toc,
    };
  }

  async getToc(ref: string): Promise<TocEntry[]> {
    const page = await this.resolveRef(ref);
    return page.toc;
  }

  async getMeta(ref: string): Promise<Record<string, unknown>> {
    const page = await this.resolveRef(ref);
    return page.meta;
  }

  async getSection(ref: string, anchor: string): Promise<{ title: string; markdown: string }> {
    const page = await this.resolveRef(ref);
    const section = extractSection(page.body, anchor);
    if (!section) {
      throw new NotFoundError(
        `Section "#${anchor}" not found on ${page.url}. Available: ${page.toc.map((t) => t.anchor).join(', ') || '(none)'}`,
      );
    }
    return section;
  }

  async getLlmsTxt(full = false): Promise<string | null> {
    const name = full ? 'llms-full.txt' : 'llms.txt';
    const candidates = [path.join(this.rootDir, name), path.join(this.rootDir, 'public', name)];
    for (const candidate of candidates) {
      try {
        return await this.readFileWithinRoot(candidate);
      } catch (err) {
        if (isNotFoundError(err)) continue;
        logger.warn({ err, candidate }, 'local: failed to read llms.txt candidate');
      }
    }
    return null;
  }

  /**
   * Read a file, refusing to follow a symlink that resolves outside
   * `rootDir`. Git supports committing symlinks, so cloning an untrusted
   * docs repo and pointing `--local` at it could otherwise let a symlink
   * (e.g. `llms.txt -> /etc/passwd`) exfiltrate arbitrary host files via a
   * fixed-name read.
   */
  private async readFileWithinRoot(candidate: string): Promise<string> {
    const real = await fs.realpath(candidate);
    const realRoot = await fs.realpath(this.rootDir);
    const rel = path.relative(realRoot, real);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new SourceError(`Refusing to read a file outside the project root: ${candidate}`);
    }
    return fs.readFile(real, 'utf8');
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // entry.isDirectory()/isFile() reflect the dirent's own type and do NOT
    // follow symlinks (a symlink's dirent type is neither "file" nor
    // "directory"), so symlinked entries are intentionally skipped here
    // rather than traversed/read - this prevents a symlink planted inside
    // contentDir (e.g. from an untrusted cloned docs repo) from escaping it.
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function matchesTag(metaTag: unknown, wanted: string): boolean {
  if (Array.isArray(metaTag)) return metaTag.includes(wanted);
  return metaTag === wanted;
}

function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(body);
  return m ? m[1] : undefined;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function snippet(body: string, needle: string, contextChars = 80): string {
  if (!needle) return body.slice(0, 200);
  const lower = body.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx === -1) return body.slice(0, 200);
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(body.length, idx + needle.length + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}
