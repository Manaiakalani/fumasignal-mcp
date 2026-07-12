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
  /**
   * Max size (bytes) of an individual `.md`/`.mdx` file to read into the
   * index. Files larger than this are skipped (logged, not thrown) rather
   * than read in full - `contentDir` can point at an untrusted cloned docs
   * repo (see `readFileWithinRoot()`'s doc comment for the same threat
   * model applied to symlinks), and every indexed file's body/toc/meta is
   * held in memory for the process's lifetime with no TTL/eviction, unlike
   * the remote source's byte-bounded `pageCache`. Without a per-file cap,
   * one huge file (planted deliberately, or just an oversized file that
   * doesn't belong in a docs tree) would be read and retained in full.
   * Default 10MB (matches the remote source's `maxResponseBytes` default).
   */
  maxFileBytes?: number;
  /**
   * Hard cap on the combined size (bytes) of every `.md`/`.mdx` file's
   * content actually read into the index across the whole `buildIndex()`
   * walk. `maxFileBytes` alone is not sufficient: it only bounds a single
   * file, so an untrusted cloned docs repo (see `maxFileBytes`'s doc
   * comment) containing many files each just under that per-file cap can
   * still, in aggregate, retain far more than any one file would - every
   * indexed page's body/toc/meta lives for the process's lifetime with no
   * TTL/eviction, unlike the remote source's byte-bounded `pageCache`
   * (which enforces an aggregate cap independently of any single response's
   * size - see `maxPageCacheBytes` in remote.ts). Once the running total
   * would exceed this budget, indexing stops (files already indexed remain
   * served; the rest of the walk is abandoned, logged once as a warning)
   * rather than continuing to stat/read further files against an
   * already-exhausted budget. Default 200MB - generous headroom for any
   * real docs tree, not a functional restriction.
   */
  maxTotalBytes?: number;
  /**
   * Hard cap on the number of `.md`/`.mdx` files indexed across the whole
   * `buildIndex()` walk. `maxTotalBytes` alone is not sufficient: a
   * directory containing an extremely large number of tiny files (each far
   * under `maxFileBytes`, and collectively far under `maxTotalBytes`)
   * still costs a `Map` entry plus a `toc`/`meta` object per file, and that
   * per-page bookkeeping overhead dominates at a large enough file count
   * regardless of how small each file's content is. Bounding the count
   * here, the same way `MAX_SITEMAP_URLS` bounds sitemap URL count
   * independently of `MAX_SITEMAP_URL_BYTES` (see remote.ts - one budget
   * alone leaves exactly this kind of gap for the shape it doesn't cover),
   * closes that gap. Default 50,000 - generous headroom for any real docs
   * tree, not a functional restriction.
   */
  maxFileCount?: number;
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
  /**
   * True when `contentDir` was derived by joining `rootDir` with a
   * relative path (the default, or a relative `--content-dir`), meaning
   * the caller's intent is that it lives *inside* `rootDir`. False when
   * the caller passed an explicit absolute `--content-dir`, which is
   * allowed to point anywhere by design. Used by `buildIndex()` to decide
   * whether a symlink-escape check applies (see there for why).
   */
  private contentDirIsRelative: boolean;
  private urlPrefix: string;
  private maxFileBytes: number;
  private maxTotalBytes: number;
  private maxFileCount: number;
  private indexPromise: Promise<Map<string, IndexedPage>> | null = null;

  constructor(opts: LocalSourceOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    const cd = opts.contentDir ?? 'content/docs';
    this.contentDirIsRelative = !path.isAbsolute(cd);
    this.contentDir = this.contentDirIsRelative ? path.join(this.rootDir, cd) : cd;
    this.urlPrefix = (opts.urlPrefix ?? '/docs').replace(/\/+$/, '');
    this.maxFileBytes = opts.maxFileBytes ?? 10_000_000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 200_000_000;
    this.maxFileCount = opts.maxFileCount ?? 50_000;
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
    if (this.contentDirIsRelative) {
      // `fs.stat` above follows symlinks, and `fs.readdir` on a symlinked
      // directory transparently follows it too - so if `contentDir` (or any
      // ancestor of it under rootDir) is itself a symlink, indexing would
      // silently walk and serve files from wherever it resolves, even
      // though `walk()`'s own dirent-type check only skips symlinks found
      // *during* the walk (entries below the starting directory), not the
      // starting directory itself. This is the same "untrusted cloned docs
      // repo" threat model as `readFileWithinRoot()` below, just at the
      // content-directory boundary instead of a fixed filename.
      await this.assertRealpathWithinRoot(this.contentDir);
    }
    // walk() already filters to .md/.mdx during traversal (see its doc
    // comment), so every entry here is a content file - no extension
    // re-check needed.
    const files = await walk(this.contentDir);
    let totalBytes = 0;
    let indexedCount = 0;
    for (const file of files) {
      // Enforce maxFileCount *before* doing any work for this file - once
      // reached, every remaining file would just be skipped anyway (see
      // maxFileCount's doc comment), so stop the walk outright instead of
      // stat-ing the rest of a possibly huge remaining file list for
      // nothing.
      if (indexedCount >= this.maxFileCount) {
        logger.warn(
          { dir: this.contentDir, maxFileCount: this.maxFileCount },
          'local: stopping index build - maxFileCount reached; remaining files will not be indexed',
        );
        break;
      }
      const rel = path.relative(this.contentDir, file).replace(/\\/g, '/');
      let slug = rel.replace(/\.mdx?$/i, '');
      if (slug === 'index') slug = '';
      else if (slug.endsWith('/index')) slug = slug.slice(0, -'/index'.length);
      const url = slug ? `${this.urlPrefix}/${slug}` : this.urlPrefix;
      let raw: string;
      let body: string;
      let meta: Record<string, unknown>;
      try {
        // Check the file's size *before* reading it in full: contentDir
        // can point at an untrusted cloned docs repo (see the symlink
        // comment above), and the index holds every page's body/toc/meta
        // in memory for the process's lifetime with no eviction, so one
        // oversized file - deliberately planted or just a mistake - would
        // otherwise be read and retained in full with no cap at all.
        const fileStat = await fs.stat(file);
        if (fileStat.size > this.maxFileBytes) {
          logger.warn(
            { file, size: fileStat.size, maxFileBytes: this.maxFileBytes },
            'local: skipping page that exceeds maxFileBytes',
          );
          continue;
        }
        // Aggregate check, independent of the per-file cap above: many
        // files each under maxFileBytes can still sum to far more than any
        // one file would (see maxTotalBytes's doc comment). Checked before
        // reading, the same "test before you commit to the cost" shape as
        // the per-file check, so a huge remaining file list stops the walk
        // rather than being read only to be retained anyway.
        if (totalBytes + fileStat.size > this.maxTotalBytes) {
          logger.warn(
            { dir: this.contentDir, totalBytes, maxTotalBytes: this.maxTotalBytes },
            'local: stopping index build - maxTotalBytes budget exhausted; remaining files will not be indexed',
          );
          break;
        }
        raw = await fs.readFile(file, 'utf8');
        ({ content: body, data: meta } = parseFrontmatter(raw));
        totalBytes += fileStat.size;
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
      indexedCount++;
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
   * Resolve `candidate` to its real (symlink-free) path and throw if it
   * falls outside `rootDir`'s own real path. Shared by the contentDir
   * boundary check above and `readFileWithinRoot()` below.
   */
  private async assertRealpathWithinRoot(candidate: string): Promise<string> {
    const real = await fs.realpath(candidate);
    const realRoot = await fs.realpath(this.rootDir);
    const rel = path.relative(realRoot, real);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new SourceError(`Refusing to access a path outside the project root: ${candidate}`);
    }
    return real;
  }

  /**
   * Read a file, refusing to follow a symlink that resolves outside
   * `rootDir`. Git supports committing symlinks, so cloning an untrusted
   * docs repo and pointing `--local` at it could otherwise let a symlink
   * (e.g. `llms.txt -> /etc/passwd`) exfiltrate arbitrary host files via a
   * fixed-name read.
   */
  /**
   * Read a file, refusing to follow a symlink that resolves outside
   * `rootDir`. Git supports committing symlinks, so cloning an untrusted
   * docs repo and pointing `--local` at it could otherwise let a symlink
   * (e.g. `llms.txt -> /etc/passwd`) exfiltrate arbitrary host files via a
   * fixed-name read. Also enforces `maxFileBytes` (see its doc comment) -
   * the same untrusted-repo threat model applies to file *size*, not just
   * symlink targets.
   */
  private async readFileWithinRoot(candidate: string): Promise<string> {
    const real = await this.assertRealpathWithinRoot(candidate);
    const fileStat = await fs.stat(real);
    if (fileStat.size > this.maxFileBytes) {
      throw new SourceError(
        `Refusing to read "${candidate}": ${fileStat.size} bytes exceeds the ${this.maxFileBytes}-byte limit.`,
      );
    }
    return fs.readFile(real, 'utf8');
  }
}

/**
 * Recursively collect every `.md`/`.mdx` file under `dir`. Filtering to the
 * two content extensions *here*, during traversal, rather than after
 * `walk()` returns - matters when `dir` holds many non-content files
 * (images, generated assets, etc. are common in a docs repo): without it,
 * the returned array (and the recursive `push(...)` calls that build it -
 * see below) would momentarily hold every file path in the tree, not just
 * the ones `buildIndex()` will ever read.
 */
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
      // Not `out.push(...(await walk(full)))`: spreading a large array as
      // call arguments hits a JS engine argument-count ceiling - empirically
      // confirmed to throw `RangeError: Maximum call stack size exceeded`
      // on Node for arrays of roughly 125,000+ elements (varies by engine
      // build/version, but is well within reach of a docs tree with a
      // large number of content files, deliberately structured to attack
      // this or not). A plain loop has no such limit.
      for (const child of await walk(full)) out.push(child);
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
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
  // See extractTitle() in src/sources/remote.ts / the comment on
  // HEADING_PREFIX_RE in src/lib/markdown.ts: the old
  // `/^#\s+(.+?)\s*$/m` pattern is a catastrophic-backtracking ReDoS.
  // This per-line greedy-to-end-anchor version is linear instead.
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s+(.*)$/.exec(line);
    if (!m) continue;
    const title = m[1]!.trim();
    if (title) return title;
  }
  return undefined;
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
