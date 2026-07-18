import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type HeadingIndex,
  buildHeadingIndex,
  sectionFromHeadingIndex,
  tocFromHeadingIndex,
} from '../lib/markdown.js';
import { parseFrontmatter, asNonEmptyString } from '../lib/frontmatter.js';
import { hasPathPrefix } from '../lib/sitemap.js';
import { logger } from '../lib/logger.js';
import { safeSliceStart, safeTruncateLength } from '../lib/text-safety.js';
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

/**
 * Upper bound on how many distinct query tokens `search()` will actually
 * score per call. Without this, `search()`'s cost is
 * O(query.split(/\s+/).length * total indexed bytes): the `query` MCP tool
 * parameter is capped at 500 characters (see server.ts), which still
 * allows up to ~250 single-character tokens, each scored via a full linear
 * scan (`countOccurrences()`) over *every* indexed page's body - against a
 * fully-populated default-sized (`maxTotalBytes`) index, empirically
 * measured at 10-25+ seconds of synchronous, event-loop-blocking work for
 * a *single* search call, stalling every other concurrent request/tool
 * call this (single-threaded) server is handling for that entire time.
 * Deduplicating first (below) closes off the cheapest version of this - a
 * query that repeats one token as many times as fits in 500 characters -
 * almost for free; this cap bounds the remaining "many genuinely distinct
 * short tokens" variant that deduplication alone can't help with. Far more
 * generous than any real multi-word search query needs.
 */
const MAX_SEARCH_TOKENS = 20;

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
   *
   * Also passed to `walk()` as the max number of paths it will ever
   * enumerate, not just how many `buildIndex()` will index: capping only
   * the read/index step would still let `walk()` itself collect (and hold
   * in memory, as one big array of strings) every matching path in an
   * arbitrarily large tree before that cap is ever consulted. One
   * consequence: if any of the first `maxFileCount` files `walk()` finds
   * are skipped (e.g. for exceeding `maxFileBytes`), the total actually
   * indexed can end up below `maxFileCount` even if the tree contains
   * further valid files beyond that point - an intentional trade-off
   * (bounding enumeration cost) rather than a guarantee that exactly this
   * many files will be indexed whenever that many valid ones exist.
   */
  maxFileCount?: number;
  /**
   * How long (ms) a successfully-built index is served before the next
   * `index()` call rebuilds it from disk, so edits/adds/deletes under
   * `contentDir` eventually become visible without restarting the process.
   * Without this, `indexPromise` below was cached *forever* once built:
   * an MCP server is typically a long-lived background process (e.g. one
   * spawned by an editor/assistant integration and left running for a
   * whole session), and local mode's own value proposition - pointing it
   * at docs you're actively writing - is defeated if the server can never
   * see a change made after its first request. Default 5 minutes, matching
   * `RemoteFumadocsSource`'s `cacheTtlMs` default (the CLI's `--cache-ttl`
   * flag/`FUMASIGNAL_CACHE_TTL` env var feeds this in local mode, the same
   * way it feeds the remote source's response cache in remote mode).
   */
  indexTtlMs?: number;
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
  /**
   * Cached alongside `toc` so `getSection()` can look up a section without
   * re-splitting/re-scanning `body` from scratch on every call - see
   * `buildHeadingIndex()`'s doc comment.
   */
  headingIndex: HeadingIndex;
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
  private indexTtlMs: number;
  private indexPromise: Promise<Map<string, IndexedPage>> | null = null;
  /**
   * When the currently-cached `indexPromise` expires and should be rebuilt
   * on the next `index()` call. 0 is overloaded to mean "not applicable
   * right now" - either no build has ever succeeded yet, or one is
   * currently in flight - so a concurrent caller never mistakes an
   * in-progress (not-yet-resolved) build for a stale one and kicks off a
   * redundant second `buildIndex()` walk racing the first.
   */
  private indexExpiresAt = 0;

  constructor(opts: LocalSourceOptions) {
    this.rootDir = path.resolve(opts.rootDir);
    const cd = opts.contentDir ?? 'content/docs';
    this.contentDirIsRelative = !path.isAbsolute(cd);
    this.contentDir = this.contentDirIsRelative ? path.join(this.rootDir, cd) : cd;
    this.urlPrefix = (opts.urlPrefix ?? '/docs').replace(/\/+$/, '');
    this.maxFileBytes = opts.maxFileBytes ?? 10_000_000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 200_000_000;
    this.maxFileCount = opts.maxFileCount ?? 50_000;
    this.indexTtlMs = opts.indexTtlMs ?? 5 * 60 * 1000;
    this.label = `local:${this.rootDir}`;
  }

  private async index(): Promise<Map<string, IndexedPage>> {
    const isStale =
      this.indexPromise !== null && this.indexExpiresAt !== 0 && Date.now() >= this.indexExpiresAt;
    if (!this.indexPromise || isStale) {
      // Mark "build in flight" *before* starting the rebuild so a
      // concurrent call arriving while it's pending sees indexExpiresAt
      // === 0 (not "stale") and awaits this same build instead of
      // triggering another one - see indexExpiresAt's doc comment.
      this.indexExpiresAt = 0;
      // buildIndex() can fail for reasons that are transient or
      // environment-specific rather than a fixed, permanent
      // misconfiguration - e.g. a network-mounted contentDir that hiccups
      // on the very first request, or a TOCTOU race between the fs.stat()
      // and fs.opendir() calls inside buildIndex(). If the rejected promise
      // stayed cached in this.indexPromise, every future call would keep
      // replaying that one failure forever - even long after whatever
      // caused it has resolved - until the process is restarted. Resetting
      // indexPromise to null on rejection (before letting the caller see
      // it) makes the *next* call retry buildIndex() from scratch instead.
      this.indexPromise = this.buildIndex()
        .then((idx) => {
          this.indexExpiresAt = Date.now() + this.indexTtlMs;
          return idx;
        })
        .catch((err: unknown) => {
          this.indexPromise = null;
          this.indexExpiresAt = 0;
          throw err;
        });
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
    // walk() already filters to .md/.mdx during traversal, and stops
    // enumerating once maxFileCount paths are found (see its doc comment),
    // so every entry here is a content file and the list itself can never
    // exceed maxFileCount - no extension re-check needed.
    const files = await walk(this.contentDir, this.maxFileCount);
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
      // `|| '/'` (not bare `this.urlPrefix`): when --docs-prefix is "/"
      // (a root-mounted docs site), urlPrefix normalizes to "" (all
      // trailing slashes stripped - see its assignment above), so the
      // *root* index page (empty slug) would otherwise get url === "" -
      // not a valid path, and likely unusable as a `ref` back into
      // get_page/get_toc/get_section (MCP tool schemas require a
      // non-empty `ref` string). Slugged pages are unaffected: "" + "/"
      // + slug already produces the correct "/slug" either way.
      const url = slug ? `${this.urlPrefix}/${slug}` : this.urlPrefix || '/';
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
        // Charge the aggregate byte budget *before* attempting to read/parse
        // the file, not after a successful parse: if this were charged only
        // on success (as it was before), a file that reads fine but whose
        // frontmatter parseFrontmatter() rejects (or that fails for any
        // other reason after the read) would pay for a full fs.readFile()
        // - the actual I/O/CPU cost maxTotalBytes exists to bound - while
        // leaving totalBytes at 0. A tree of many large-but-invalid files
        // (each individually under maxFileBytes) could then be read in full
        // repeatedly without ever tripping the aggregate budget, since it
        // only advances for files that happen to parse successfully.
        totalBytes += fileStat.size;
        raw = await fs.readFile(file, 'utf8');
        ({ content: body, data: meta } = parseFrontmatter(raw));
      } catch (err) {
        logger.warn({ err, file }, 'local: skipping page that failed to read/parse');
        continue;
      }
      const headingIndex = buildHeadingIndex(body);
      const toc = tocFromHeadingIndex(headingIndex);
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
        headingIndex,
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
    // Mirror the `|| '/'` fallback in buildIndex()'s own `url` computation
    // above: with --docs-prefix "/", the root page is stored under the
    // key "/", not "" - this keeps the lookup key in sync with it.
    if (r === '') r = this.urlPrefix || '/';
    // `idx` is keyed by literal (unencoded) filesystem-derived paths - see
    // buildIndex(): a file "API Reference.mdx" is keyed as
    // "/docs/API Reference" with a real space, never "%20". `.pathname` on
    // a URL (the branch above) never decodes percent-encoding, and a
    // caller-supplied path-style ref may be percent-encoded too - without
    // this, get_page/get_toc/get_section would 404 on any indexed page
    // whose slug needs URL-encoding. Decoding here has no
    // traversal/authorization concern (unlike remote.ts, which re-fetches
    // over the network and must independently re-validate a docsPrefix
    // boundary): `idx` is a closed map of exactly the pages indexed from
    // disk, so a decoded ref can only ever look up a key that's already
    // legitimately in it, or fail to match. A malformed escape is left
    // as-is (falls through to the NotFoundError below) rather than
    // thrown, matching this function's existing fail-soft normalization.
    try {
      r = decodeURIComponent(r);
    } catch {
      // ignore - unmatched (NotFoundError) rather than a thrown error
    }
    const direct = idx.get(r);
    if (direct) return direct;
    throw new NotFoundError(`Local page not found for ref "${ref}" (looked up "${r}")`);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const idx = await this.index();
    const query = opts.query.trim().toLowerCase();
    if (!query) return [];
    const tokens = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, MAX_SEARCH_TOKENS);
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
            excerpt: snippet(page.body, tokens),
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
    const section = sectionFromHeadingIndex(page.headingIndex, anchor);
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
    // Track the first non-"not found" failure (oversized file, a symlink
    // escaping rootDir, permission denied, ...) across both candidates
    // rather than only logging-and-continuing as before: swallowing it
    // into the same `null` this method returns for a genuine absence
    // mirrors RemoteFumadocsSource.getLlmsTxt's real 404 vs. request-
    // failure distinction, so the get_llms_txt tool doesn't misreport "this
    // site does not expose llms.txt" when the file actually exists but
    // couldn't be read for an unrelated reason.
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return await this.readFileWithinRoot(candidate);
      } catch (err) {
        if (isNotFoundError(err)) continue;
        lastError = err;
        logger.warn({ err, candidate }, 'local: failed to read llms.txt candidate');
      }
    }
    if (lastError !== undefined) {
      throw new SourceError(
        `Found ${name} but could not read it: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
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
 * Recursively collect every `.md`/`.mdx` file under `dir`, up to `limit`
 * total paths. Filtering to the two content extensions *here*, during
 * traversal, rather than after `walk()` returns - matters when `dir` holds
 * many non-content files (images, generated assets, etc. are common in a
 * docs repo): without it, the returned array (and the recursive loop that
 * builds it - see below) would momentarily hold every file path in the
 * tree, not just the ones `buildIndex()` will ever read.
 *
 * `limit` (`buildIndex()` passes `maxFileCount`) stops the walk itself once
 * enough paths have been found, rather than only being enforced after the
 * fact by `buildIndex()`'s own loop: an untrusted `contentDir` (see
 * `maxFileCount`'s doc comment) with an extremely large number of matching
 * files would otherwise make `walk()` enumerate and return every one of
 * them - megabytes of path strings alone - before `buildIndex()` ever gets
 * a chance to apply its budget. Threaded through the recursion as "however
 * much budget remains" rather than a shared mutable counter, since each
 * call only needs to know how many more entries it may still contribute.
 *
 * Uses `fs.opendir()` rather than `fs.readdir()` for the same reason:
 * `readdir()` always reads and materializes *every* entry of a directory
 * into one array before returning, regardless of how many the caller
 * actually wants - so a single directory (not even a deeply nested tree,
 * just one flat directory) containing an extremely large number of entries
 * would still be read and buffered in full before the `limit` check below
 * ever runs, the same class of gap `limit` was threaded through the
 * recursion to close, just one level lower (within a single directory
 * rather than across sibling/nested ones). `opendir()`'s `Dir` is an async
 * iterable that reads entries incrementally - breaking out of the loop
 * (which `for await...of` does automatically once the iterable itself is
 * abandoned) stops it from reading any further entries at all, so entries
 * beyond `limit` are never read from disk nor turned into `Dirent` objects
 * in the first place, not just excluded from the returned array.
 */
async function walk(dir: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  if (limit <= 0) return out;
  const dirHandle = await fs.opendir(dir);
  for await (const entry of dirHandle) {
    if (out.length >= limit) break;
    const full = path.join(dir, entry.name);
    // entry.isDirectory()/isFile() reflect the dirent's own type and do NOT
    // follow symlinks (a symlink's dirent type is neither "file" nor
    // "directory"), so symlinked entries are intentionally skipped here
    // rather than traversed/read - this prevents a symlink planted inside
    // contentDir (e.g. from an untrusted cloned docs repo) from escaping it.
    if (entry.isDirectory()) {
      // A single unreadable/unwalkable subdirectory (permission denied,
      // removed/renamed mid-walk, etc.) must not abort indexing of every
      // *other* file in the tree - consistent with how buildIndex() already
      // skips+logs a single bad *file* rather than aborting the whole build
      // (see its per-file catch). Without this, one bad subtree would
      // reject this entire walk() call all the way up through the
      // recursion to buildIndex(), which has no try/catch around its call
      // to walk() - and since index() used to cache that rejection forever
      // (see its doc comment), a single transient EACCES on one
      // subdirectory could take the whole local source down for every
      // caller until process restart.
      let children: string[];
      try {
        // Not `out.push(...(await walk(full, ...)))`: spreading a large array
        // as call arguments hits a JS engine argument-count ceiling -
        // empirically confirmed to throw `RangeError: Maximum call stack size
        // exceeded` on Node for arrays of roughly 125,000+ elements (varies by
        // engine build/version, but is well within reach of a docs tree with
        // a large number of content files, deliberately structured to attack
        // this or not). A plain loop has no such limit.
        children = await walk(full, limit - out.length);
      } catch (err) {
        logger.warn({ err, dir: full }, 'local: skipping unreadable subdirectory during index walk');
        continue;
      }
      for (const child of children) out.push(child);
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

/** Escape regex metacharacters so a plain-text needle is matched literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find `needle` in `body` case-insensitively and return an excerpt around
 * the match.
 *
 * Searches `body` directly via a case-insensitive regex instead of the
 * more obvious `body.toLowerCase().indexOf(needle)` - that approach finds
 * the match's offset in a *lowercased copy* of `body`, then uses that
 * offset to slice the *original* `body`, which silently assumes
 * `toLowerCase()` never changes a string's length. It can: Turkish
 * "İ" (U+0130) lowercases to a 2-code-unit "i" + combining dot above
 * (U+0069 U+0307), so 120 of them before a match shifted the lowercased
 * offset 120 UTF-16 units ahead of the real one in `body` - empirically,
 * this produced a `start > end` slice and returned just "…" with no
 * excerpt content at all, for a query that legitimately matched.
 * `RegExp`'s `i` flag doesn't have this problem: per the spec's
 * `Canonicalize` operation, a character is only case-folded for `/i`
 * matching if doing so keeps it a single code unit, so `match[0].length`
 * is always exactly `needle.length` and `match.index` is always a valid
 * offset into the *original* `body`. `needle` is escaped since it's
 * caller-supplied (a search query token) and would otherwise be
 * interpreted as regex syntax; escaping makes every character literal,
 * so this can't reintroduce a ReDoS shape (no quantifiers/alternation are
 * ever present in the compiled pattern).
 *
 * Accepts every query token, not just the first: a page can match a
 * multi-token query because its *title* or `toc` contains a later
 * token while its body only contains an earlier one, or none at all
 * (see search()'s own scoring, which checks title/description/toc
 * independently of body). Trying only `needles[0]` against `body` in
 * that case never matches, silently falling back to an arbitrary
 * `body.slice(0, 200)` excerpt with no relevance to why the page
 * matched. Joining every token into one alternation and taking whichever
 * occurs earliest in `body` picks the most relevant excerpt available
 * while still doing a single linear scan (alternation of literal,
 * quantifier-free branches is O(tokens x body length) at worst - a
 * constant-factor slowdown bounded by MAX_SEARCH_TOKENS, not a new
 * ReDoS shape).
 */
function snippet(body: string, needles: string[], contextChars = 80): string {
  const escaped = needles.filter(Boolean).map(escapeRegExp);
  if (escaped.length === 0) return body.slice(0, 200);
  const match = new RegExp(escaped.join('|'), 'i').exec(body);
  if (!match) return body.slice(0, 200);
  const idx = match.index;
  const start = safeSliceStart(body, Math.max(0, idx - contextChars));
  const end = safeTruncateLength(body, Math.min(body.length, idx + match[0].length + contextChars));
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}
