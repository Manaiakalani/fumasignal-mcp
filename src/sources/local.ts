import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { extractSection, extractToc, slugify } from '../lib/markdown.js';
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
    } catch {
      throw new SourceError(
        `Local content directory not found: ${this.contentDir}. Pass --content-dir to override.`,
      );
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
      const raw = await fs.readFile(file, 'utf8');
      const parsed = matter(raw);
      const body = parsed.content;
      const meta = (parsed.data ?? {}) as Record<string, unknown>;
      const toc = extractToc(body);
      const title =
        (meta.title as string | undefined) ??
        firstHeading(body) ??
        slug.split('/').pop() ??
        'Untitled';
      const description = meta.description as string | undefined;
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
    // Try matching by slug suffix
    for (const page of idx.values()) {
      if (page.url === r || page.slug === r.replace(`${this.urlPrefix}/`, '')) return page;
    }
    throw new NotFoundError(`Local page not found for ref "${ref}" (looked up "${r}")`);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const idx = await this.index();
    const query = opts.query.trim().toLowerCase();
    if (!query) return [];
    const tokens = query.split(/\s+/).filter(Boolean);
    const scored: Array<{ hit: SearchHit; score: number }> = [];
    for (const page of idx.values()) {
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
      if (prefix && !page.url.startsWith(prefix)) continue;
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
    const candidate = path.join(this.rootDir, full ? 'llms-full.txt' : 'llms.txt');
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Also check public/ directory.
      try {
        return await fs.readFile(
          path.join(this.rootDir, 'public', full ? 'llms-full.txt' : 'llms.txt'),
          'utf8',
        );
      } catch {
        return null;
      }
    }
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
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

// Suppress unused-import lint warning when slugify isn't used (kept for future).
void slugify;
