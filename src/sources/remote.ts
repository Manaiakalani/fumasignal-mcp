import { logger } from '../lib/logger.js';
import { TtlCache, Coalescer, Semaphore } from '../lib/cache.js';
import { htmlToMarkdown } from '../lib/html-to-md.js';
import { extractSection, extractToc } from '../lib/markdown.js';
import { parseFrontmatter, asNonEmptyString } from '../lib/frontmatter.js';
import {
  decodeAndNormalizePathname,
  filterToDocs,
  hasPathPrefix,
  isSitemapIndex,
  parseSitemap,
} from '../lib/sitemap.js';
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

export interface RemoteSourceOptions {
  baseUrl: string;
  /** Path of the search API. Default: "/api/search". */
  searchPath?: string;
  /** Path prefix for doc pages (used to filter sitemap). Default: "/docs". */
  docsPrefix?: string;
  /** Optional Authorization header value (e.g. "Bearer xxx"). */
  authHeader?: string;
  /** TTL for fetched pages and sitemap. Default 5 min. */
  cacheTtlMs?: number;
  /** Override fetch (used by tests). */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Per-request fetch timeout in ms. Default 15s. */
  fetchTimeoutMs?: number;
  /** Max same-origin redirects to follow before giving up. Default 5. */
  maxRedirects?: number;
  /**
   * Max bytes to read from any single response body before aborting.
   * Protects against OOM from a huge/malicious/misbehaving response (a lied
   * Content-Length or an unbounded chunked body). Default 10MB.
   */
  maxResponseBytes?: number;
  /**
   * Soft cap on the *combined* size (approximated by markdown length) of
   * all pages held in the page cache at once. `maxResponseBytes` alone
   * only bounds a single response; without this, the cache's `maxEntries`
   * (500) distinct large pages could still accumulate to `maxEntries *
   * maxResponseBytes` (~5GB at the defaults). Default 50MB.
   */
  maxPageCacheBytes?: number;
  /**
   * Max number of outbound fetches (across search, sitemap, llms.txt, and
   * page requests) allowed to be in flight at once; additional calls queue
   * FIFO until a slot frees up. `Coalescer` only de-dupes *identical* keys,
   * so without this, concurrent requests for many *distinct* pages/queries
   * would each independently buffer up to `maxResponseBytes`, with nothing
   * bounding the aggregate. Default 8.
   */
  maxConcurrentFetches?: number;
}

const DEFAULT_UA = 'fumasignal-mcp/0.1 (+https://github.com/Manaiakalani/fumasignal-mcp)';

/**
 * Bounds for recursive sitemap-index traversal (see `fetchSitemapUrls()`).
 * A sitemap index's <loc> entries point to other sitemaps rather than
 * pages; a malicious or misconfigured site could otherwise cause
 * unbounded fetching via deep nesting or wide fan-out.
 */
const MAX_SITEMAP_INDEX_DEPTH = 5;
const MAX_SITEMAP_FETCHES = 200;
/**
 * Hard cap on the total number of <loc> URLs accumulated across every
 * sitemap fetched while resolving a (possibly multi-level) sitemap index.
 * `MAX_SITEMAP_FETCHES` only bounds the *number of HTTP requests* - each
 * individual response can still hold up to `maxResponseBytes` (10MB by
 * default) of tightly packed `<loc>` entries, so without an independent
 * cap on the accumulated *URL count* a malicious/compromised site can
 * fan out to `MAX_SITEMAP_FETCHES` maximally-packed leaf sitemaps and
 * force a multi-GB in-memory URL list - empirically confirmed: 20 leaf
 * sitemaps x 50k URLs each (1M URLs) grew the heap by ~608MB, and that
 * scales linearly, so the real 200-fetch budget extrapolates to ~6GB,
 * enough to crash the process. The result also gets held indefinitely in
 * `listCache` until TTL expiry, and `listCache`'s own `maxTotalSize`
 * can't help here (see its construction below) since it only ever holds
 * one key ('all') - eviction never has anything else to reclaim from, so
 * the single oversized entry is always let through. Capping accumulation
 * at the source, here, is what actually bounds memory. No real
 * documentation site remotely approaches this limit, so it's generous
 * headroom, not a functional restriction.
 */
const MAX_SITEMAP_URLS = 200_000;

/**
 * Cancel a response body we're intentionally not reading, so the
 * underlying connection can be released promptly instead of idling until
 * it times out.
 */
async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/**
 * A FumadocsSource that talks to a deployed Fumadocs site over HTTP.
 *
 * Strategy:
 *   - Search uses the site's Orama search API (default "/api/search").
 *   - Page list uses the site's "/sitemap.xml" filtered to docsPrefix.
 *   - Page content tries "<url>.md" / "<url>/raw" first, then falls back
 *     to scraping the rendered HTML.
 *   - llms.txt is fetched verbatim.
 */
export class RemoteFumadocsSource implements FumadocsSource {
  readonly label: string;
  private base: URL;
  private searchPath: string;
  private docsPrefix: string;
  private authHeader?: string;
  private fetchImpl: typeof fetch;
  private ua: string;
  private fetchTimeoutMs: number;
  private maxRedirects: number;
  private maxResponseBytes: number;
  private pageCache: TtlCache<string, PageContent>;
  private listCache: TtlCache<'all', PageSummary[]>;
  private llmsCache: TtlCache<string, string | null>;
  // Coalesce concurrent cache-miss fetches for the same key so parallel
  // callers share one fetch chain instead of each independently repeating
  // it (see `Coalescer`'s doc comment).
  private pagePending = new Coalescer<string, PageContent>();
  private listPending = new Coalescer<'all', PageSummary[]>();
  private llmsPending = new Coalescer<string, string | null>();
  // Bounds aggregate in-flight fetches across distinct keys (see
  // `Semaphore`'s doc comment) - `pagePending`/etc. above only collapse
  // duplicate requests for the *same* key.
  private fetchSemaphore: Semaphore;

  constructor(opts: RemoteSourceOptions) {
    this.base = new URL(opts.baseUrl);
    // Strip trailing slash for consistent URL building
    if (this.base.pathname.endsWith('/') && this.base.pathname !== '/') {
      this.base.pathname = this.base.pathname.replace(/\/+$/, '');
    }
    this.searchPath = opts.searchPath ?? '/api/search';
    this.docsPrefix = opts.docsPrefix ?? '/docs';
    this.authHeader = opts.authHeader;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.ua = opts.userAgent ?? DEFAULT_UA;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 15_000;
    this.maxRedirects = opts.maxRedirects ?? 5;
    this.maxResponseBytes = opts.maxResponseBytes ?? 10_000_000;
    const maxPageCacheBytes = opts.maxPageCacheBytes ?? 50_000_000;
    this.fetchSemaphore = new Semaphore(opts.maxConcurrentFetches ?? 8);
    const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.pageCache = new TtlCache(ttl, 500, {
      maxTotalSize: maxPageCacheBytes,
      sizeOf: (page) => pageContentSize(page, this.maxResponseBytes),
    });
    this.listCache = new TtlCache(ttl);
    this.llmsCache = new TtlCache(ttl);
    this.label = `remote:${this.base.origin}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': this.ua,
      Accept: 'application/json, text/markdown, text/plain, text/html;q=0.9, */*;q=0.5',
      ...(this.authHeader ? { Authorization: this.authHeader } : {}),
      ...extra,
    };
    return h;
  }

  /** Normalize a "ref" (URL or path or slug) to a same-origin absolute URL. */
  private resolveRef(ref: string): URL {
    let u: URL;
    if (/^https?:\/\//i.test(ref)) {
      u = new URL(ref);
    } else if (ref.startsWith('/')) {
      // NOTE: this also covers protocol-relative refs like "//evil.com/x" -
      // new URL('//evil.com/x', base) resolves to a DIFFERENT host, so the
      // origin check below (applied uniformly to every branch) is required
      // to catch that case; it must not be limited to the absolute-URL arm.
      u = new URL(ref, this.base);
    } else {
      // Treat as slug under docsPrefix.
      const slugPath = `${this.docsPrefix.replace(/\/+$/, '')}/${ref.replace(/^\/+/, '')}`;
      u = new URL(slugPath, this.base);
    }
    if (u.origin !== this.base.origin) {
      throw new SourceError(
        `Refusing to fetch cross-origin URL: ${u.origin} (server is bound to ${this.base.origin})`,
      );
    }
    // Same-origin is necessary but not sufficient as an authorization
    // boundary: `ref` is ultimately caller-supplied (an MCP tool argument,
    // not just a value sourced from our own listPages()/search()), and the
    // configured origin may host more than docs (an internal API, admin
    // routes, etc). If an Authorization header is configured, it would be
    // attached to ANY same-origin fetch - so without this check,
    // getPage("/api/private") would happily fetch and return whatever
    // lives at that same-origin path. Restrict refs to docsPrefix.
    //
    // Check (and use) the *decoded, normalized* pathname rather than the
    // raw one - see `decodeAndNormalizePathname()`'s doc comment for why
    // the raw form alone is bypassable via encoded traversal segments.
    const normalizedPath = decodeAndNormalizePathname(u.pathname);
    if (normalizedPath === null) {
      throw new SourceError(`Refusing to fetch a URL with an unresolvable path: ${u.pathname}`);
    }
    if (!hasPathPrefix(normalizedPath, this.docsPrefix)) {
      throw new SourceError(
        `Refusing to fetch a page outside the configured docs prefix "${this.docsPrefix}": ${u.pathname}`,
      );
    }
    u.pathname = normalizedPath;
    return u;
  }

  /**
   * Fetch `url`, enforcing a timeout and manually validating same-origin on
   * the initial URL *and* on every redirect hop. `fetch` follows redirects
   * by default, which would otherwise let a same-origin (or
   * attacker-influenced) URL redirect to an arbitrary host - or downgrade
   * from https to http on the *same* host - while still attaching our
   * Authorization/UA headers. Comparing `.origin` (not `.host`) is
   * important: two URLs can share a host but differ in protocol, and a
   * host-only check would let an https->http redirect through, leaking the
   * Authorization header in plaintext.
   *
   * `init.pathPrefix`, when given, additionally re-checks every *redirect*
   * hop (not the initial URL - that's the caller's own already-validated
   * `target`, possibly with a fixed suffix like ".md" appended by
   * `buildMarkdownCandidates()`, which `hasPathPrefix()` would incorrectly
   * reject for a target exactly at the prefix root e.g. "/docs" + ".md" =
   * "/docs.md") against that path prefix via `hasPathPrefix()`.
   * Page-fetching call sites pass `docsPrefix` here: same-origin alone
   * isn't a sufficient authorization boundary for page content (see
   * `resolveRef()`), and without this, a same-origin redirect could still
   * carry a page-fetch outside docsPrefix even though the original ref was
   * validated. Sitemap/search/llms.txt call sites omit it, since those
   * legitimately live outside docsPrefix.
   *
   * The hop-0 skip described above intentionally lets the initial fetch of
   * a `/docs.md`-style root-sibling candidate through unchecked here - but
   * `fetchPageBody()` itself filters those candidates out before they ever
   * reach this method whenever `this.authHeader` is set, so a credential
   * is never attached to a request outside docsPrefix even on hop 0 (see
   * its doc comment). That filtering, not this method, is what keeps the
   * root-sibling convenience from becoming an authorization-boundary leak.
   */
  private async fetchSameOrigin(
    url: URL,
    init: { headers: Record<string, string>; pathPrefix?: string },
  ): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (current.origin !== this.base.origin) {
        throw new SourceError(
          `Refusing to fetch cross-origin URL: ${current.origin} (server is bound to ${this.base.origin})`,
        );
      }
      if (hop > 0 && init.pathPrefix !== undefined) {
        // Same decode-then-normalize treatment as `resolveRef()` - a
        // redirect Location header is just as capable of carrying an
        // encoded traversal segment as a caller-supplied ref.
        const normalizedPath = decodeAndNormalizePathname(current.pathname);
        if (normalizedPath === null || !hasPathPrefix(normalizedPath, init.pathPrefix)) {
          throw new SourceError(
            `Refusing to follow a redirect outside the configured docs prefix "${init.pathPrefix}": ${current.pathname}`,
          );
        }
        current.pathname = normalizedPath;
      }
      const res = await this.fetchImpl(current.toString(), {
        headers: init.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return res;
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return res;
        }
        await discardBody(res);
        current = next;
        continue;
      }
      return res;
    }
    throw new SourceError(`Too many redirects while fetching ${url}`);
  }

  /**
   * Read a response body as text, aborting once it exceeds
   * `this.maxResponseBytes`. `res.text()` buffers the *entire* body
   * regardless of `Content-Length` (which a server can lie about, or omit
   * entirely for chunked responses), so a huge or malicious response would
   * otherwise be read fully into memory before we get a chance to reject
   * it. Reading the stream incrementally lets us bail out early instead.
   */
  private async readCappedText(res: Response): Promise<string> {
    const body = res.body;
    if (!body) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          throw new SourceError(
            `Response body exceeded the ${this.maxResponseBytes}-byte limit while fetching ${res.url}`,
          );
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    return this.fetchSemaphore.run(async () => {
      const url = new URL(this.searchPath, this.base);
      url.searchParams.set('query', opts.query);
      if (opts.tag) url.searchParams.set('tag', opts.tag);
      if (opts.locale) url.searchParams.set('locale', opts.locale);
      const res = await this.fetchSameOrigin(url, { headers: this.headers() });
      if (!res.ok) {
        await discardBody(res);
        throw new SourceError(
          `Search request failed: ${res.status} ${res.statusText} (${url})`,
        );
      }
      const data = JSON.parse(await this.readCappedText(res)) as unknown;
      const hits = parseSearchResponse(data);
      const limit = opts.limit ?? 10;
      return hits.slice(0, limit);
    });
  }

  async listPages(prefix?: string): Promise<PageSummary[]> {
    const cached = this.listCache.get('all');
    // Coalesce concurrent misses (see `Coalescer`'s doc comment) - without
    // this, N concurrent `listPages()` calls before the sitemap has been
    // fetched once would each independently trigger the full (bounded but
    // still up to MAX_SITEMAP_FETCHES-request) sitemap-index traversal.
    const all =
      cached ??
      (await this.listPending.run('all', async () => {
        const raced = this.listCache.get('all');
        if (raced) return raced;
        const urls = await this.fetchSemaphore.run(() =>
          this.fetchSitemapUrls(new URL('/sitemap.xml', this.base), 0, {
            fetches: 0,
            visited: new Set(),
            totalUrls: 0,
          }),
        );
        const filtered = filterToDocs(urls, this.base.toString(), this.docsPrefix);
        // Dedup by path: a repeated <loc> (within one sitemap, or the same
        // page legitimately listed in more than one) would otherwise
        // inflate the returned/cached list with duplicate entries.
        const seen = new Set<string>();
        const built: PageSummary[] = [];
        for (const { path } of filtered) {
          if (seen.has(path)) continue;
          seen.add(path);
          built.push({
            id: path,
            url: path,
            title: titleFromPath(path),
            segments: path.split('/').filter(Boolean),
          });
        }
        this.listCache.set('all', built);
        logger.debug({ count: built.length }, 'remote: built page list from sitemap');
        return built;
      }));
    if (!prefix) return all;
    return all.filter((p) => hasPathPrefix(p.url, prefix));
  }

  /**
   * Fetch a sitemap and return the page URLs it contains. A sitemap is
   * either a page-level `<urlset>` (the common case) or a `<sitemapindex>`
   * whose `<loc>` entries point to OTHER sitemaps rather than pages -
   * common for large/sharded sites, and previously unhandled (an index
   * would filter down to zero pages since its <loc> entries don't match
   * docsPrefix). Recurse into index entries, bounded by both a depth
   * limit and a shared total-fetch budget (via `state`) so a malicious or
   * misconfigured site can't trigger unbounded fetching through deep
   * nesting or wide fan-out.
   *
   * `state.visited` dedupes by exact sitemap URL: without it, a
   * `<sitemapindex>` that lists the same sub-sitemap `<loc>` many times
   * would re-fetch and re-parse it every time (wasting the shared
   * `MAX_SITEMAP_FETCHES` budget on redundant work instead of genuinely
   * distinct sitemaps) and re-append its full URL list into `pages` each
   * time, which - for a large leaf sitemap repeated near the fetch
   * budget's limit - could transiently balloon memory well beyond what
   * the *distinct* URL count would ever justify.
   *
   * `state.totalUrls` enforces `MAX_SITEMAP_URLS`: applied where `locs`
   * is actually produced (both the leaf-sitemap return and the
   * fetch-count-exhausted early return below) so the cap holds no matter
   * how the fan-out is shaped - one huge leaf sitemap, or many smaller
   * ones spread across the fetch budget.
   */
  private async fetchSitemapUrls(
    url: URL,
    depth: number,
    state: { fetches: number; visited: Set<string>; totalUrls: number },
  ): Promise<string[]> {
    const key = url.toString();
    if (state.visited.has(key)) return [];
    state.visited.add(key);
    if (state.fetches >= MAX_SITEMAP_FETCHES) return [];
    state.fetches++;
    const res = await this.fetchSameOrigin(url, { headers: this.headers() });
    if (!res.ok) {
      await discardBody(res);
      throw new SourceError(`Failed to fetch ${url.pathname}: ${res.status} ${res.statusText}`);
    }
    const xml = await this.readCappedText(res);
    const locs = parseSitemap(xml);
    if (!isSitemapIndex(xml) || depth >= MAX_SITEMAP_INDEX_DEPTH) {
      return this.takeWithinUrlBudget(locs, state);
    }
    const pages: string[] = [];
    for (const loc of locs) {
      if (state.fetches >= MAX_SITEMAP_FETCHES || state.totalUrls >= MAX_SITEMAP_URLS) break;
      let subUrl: URL;
      try {
        subUrl = new URL(loc);
      } catch {
        continue;
      }
      if (subUrl.origin !== this.base.origin) continue;
      try {
        pages.push(...(await this.fetchSitemapUrls(subUrl, depth + 1, state)));
      } catch (err) {
        logger.warn({ err, url: loc }, 'remote: failed to fetch nested sitemap, skipping');
      }
    }
    return pages;
  }

  /**
   * Truncate `locs` (URLs from a single leaf sitemap) to whatever remains
   * of the shared `MAX_SITEMAP_URLS` budget, advancing `state.totalUrls`
   * accordingly. See `MAX_SITEMAP_URLS`'s doc comment for why this needs
   * to be enforced here rather than (or in addition to) at the cache
   * layer.
   */
  private takeWithinUrlBudget(locs: string[], state: { totalUrls: number }): string[] {
    const remaining = MAX_SITEMAP_URLS - state.totalUrls;
    if (remaining <= 0) return [];
    const slice = locs.length > remaining ? locs.slice(0, remaining) : locs;
    state.totalUrls += slice.length;
    return slice;
  }

  async getPage(ref: string): Promise<PageContent> {
    const target = this.resolveRef(ref);
    // Must include the query string, not just the pathname: `fetchPageBody()`'s
    // HTML-scrape fallback fetches `target` as-is (query intact - see its doc
    // comment), so a response can genuinely vary by query. Keying the cache
    // on pathname alone would let a query-bearing ref's response get cached
    // under the *same* key as the plain path, so a later plain-path request
    // would incorrectly receive whatever was fetched for the earlier query
    // (or vice versa) instead of its own content. Empirically confirmed: a
    // ref carrying a query string that changes the HTML response poisoned
    // the plain-path cache entry with the query-specific content.
    const cacheKey = target.pathname + target.search;
    const cached = this.pageCache.get(cacheKey);
    if (cached) return cached;

    // Coalesce concurrent misses for the same key into one fetch chain
    // (see `Coalescer`'s doc comment) instead of letting each concurrent
    // caller independently repeat the full markdown-candidate-then-HTML
    // fetch chain, which would multiply upstream requests and buffered
    // response memory by the number of concurrent callers.
    return this.pagePending.run(cacheKey, async () => {
      // Re-check the cache: another caller may have populated it while we
      // were waiting to be scheduled, between the check above and this
      // callback actually running.
      const raced = this.pageCache.get(cacheKey);
      if (raced) return raced;

      const { markdown, meta } = await this.fetchSemaphore.run(() => this.fetchPageBody(target));
      const toc = extractToc(markdown);
      // meta.title/description are untrusted frontmatter values (see
      // asNonEmptyString's doc comment) - guard both instead of an `as
      // string` cast so a wrong-typed value (e.g. `title: 42`) falls
      // through to the markdown/path-derived fallbacks instead of
      // silently propagating a non-string into a `string`-typed field.
      const title = asNonEmptyString(meta.title) ?? extractTitle(markdown) ?? titleFromPath(target.pathname);
      const description = asNonEmptyString(meta.description);
      const content: PageContent = {
        id: target.pathname,
        url: target.pathname,
        title,
        description,
        segments: target.pathname.split('/').filter(Boolean),
        markdown,
        meta,
        toc,
      };
      this.pageCache.set(cacheKey, content);
      return content;
    });
  }

  async getToc(ref: string): Promise<TocEntry[]> {
    return (await this.getPage(ref)).toc;
  }

  async getMeta(ref: string): Promise<Record<string, unknown>> {
    return (await this.getPage(ref)).meta;
  }

  async getSection(ref: string, anchor: string): Promise<{ title: string; markdown: string }> {
    const page = await this.getPage(ref);
    const section = extractSection(page.markdown, anchor);
    if (!section) {
      throw new NotFoundError(
        `Section "#${anchor}" not found on ${page.url}. Available: ${page.toc.map((t) => t.anchor).join(', ') || '(none)'}`,
      );
    }
    return section;
  }

  async getLlmsTxt(full = false): Promise<string | null> {
    const path = full ? '/llms-full.txt' : '/llms.txt';
    const cached = this.llmsCache.get(path);
    if (cached !== undefined) return cached;
    // Coalesce concurrent misses (see `Coalescer`'s doc comment).
    return this.llmsPending.run(path, async () => {
      const raced = this.llmsCache.get(path);
      if (raced !== undefined) return raced;
      return this.fetchSemaphore.run(async () => {
        const url = new URL(path, this.base);
        const res = await this.fetchSameOrigin(url, { headers: this.headers() });
        if (res.status === 404) {
          await discardBody(res);
          this.llmsCache.set(path, null);
          return null;
        }
        if (!res.ok) {
          await discardBody(res);
          throw new SourceError(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
        }
        const text = await this.readCappedText(res);
        this.llmsCache.set(path, text);
        return text;
      });
    });
  }

  /**
   * Fetch the page body. Try a few markdown-flavored URLs first, then fall
   * back to scraping the rendered HTML. Returns markdown + best-effort meta.
   */
  private async fetchPageBody(
    target: URL,
  ): Promise<{ markdown: string; meta: Record<string, unknown> }> {
    let candidates = buildMarkdownCandidates(target);
    if (this.authHeader) {
      // `buildMarkdownCandidates()` deliberately produces two candidates
      // that escape `docsPrefix` by one level when `target` is exactly the
      // prefix root (e.g. "/docs" -> "/docs.md", "/docs.mdx" - siblings of
      // the docs directory, not descendants of it; see its doc comment).
      // `fetchSameOrigin()`'s hop-0 skip lets those through on purpose so
      // that convention works. That widening is harmless when requests are
      // unauthenticated, but `resolveRef()`'s docsPrefix check exists
      // specifically to stop an Authorization header configured for this
      // origin from being attached to a same-origin fetch outside the
      // caller-authorized prefix (see its doc comment) - sending it to a
      // fixed-but-still-outside-prefix sibling path defeats that boundary
      // just as much as sending it to an attacker-chosen one would.
      // Empirically confirmed: without this filter, `getPage("/docs")`
      // with an authHeader configured sent Authorization to "/docs.md".
      // Restrict to in-prefix candidates whenever a credential is in play.
      candidates = candidates.filter((c) => hasPathPrefix(c.pathname, this.docsPrefix));
    }
    for (const candidate of candidates) {
      const res = await this.fetchSameOrigin(candidate, {
        headers: this.headers({ Accept: 'text/markdown, text/plain;q=0.9' }),
        pathPrefix: this.docsPrefix,
      });
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('markdown') || ct.includes('text/plain')) {
          const text = await this.readCappedText(res);
          try {
            const { content, data } = parseFrontmatter(text);
            return { markdown: content, meta: data };
          } catch (err) {
            // Malformed frontmatter on the markdown-flavored URL shouldn't
            // fail the whole page - fall through to the next candidate (or
            // the HTML scrape below) instead of throwing.
            logger.warn({ err, url: candidate.toString() }, 'remote: failed to parse frontmatter, falling back');
          }
          continue;
        }
      }
      // Body intentionally unread (wrong content-type, or a non-2xx
      // candidate - very common, since usually only one of the several
      // markdown-flavored URLs actually exists per page) - cancel it so
      // the underlying connection is released promptly instead of idling.
      await discardBody(res);
    }
    // Fallback: HTML scrape
    const res = await this.fetchSameOrigin(target, {
      headers: this.headers(),
      pathPrefix: this.docsPrefix,
    });
    if (res.status === 404) {
      await discardBody(res);
      throw new NotFoundError(`Page not found: ${target.pathname}`);
    }
    if (!res.ok) {
      await discardBody(res);
      throw new SourceError(
        `Failed to fetch ${target.pathname}: ${res.status} ${res.statusText}`,
      );
    }
    const html = await this.readCappedText(res);
    const meta = extractHtmlMeta(html);
    const markdown = htmlToMarkdown(html);
    return { markdown, meta };
  }
}

function buildMarkdownCandidates(target: URL): URL[] {
  const out: URL[] = [];
  const trimmed = target.pathname.replace(/\/+$/, '');
  const candidates = [
    `${trimmed}.md`,
    `${trimmed}.mdx`,
    `${trimmed}/raw`,
    `${trimmed}/index.md`,
  ];
  for (const c of candidates) {
    const u = new URL(target.toString());
    u.pathname = c;
    u.search = '';
    out.push(u);
  }
  return out;
}

function titleFromPath(pathname: string): string {
  const last = pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '/';
  return last
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Approximate a `PageContent`'s total in-memory footprint for the
 * pageCache's byte budget. `markdown.length` alone (the original
 * implementation) undercounts pages whose *frontmatter* (`meta`) is
 * large but the markdown body is small: `meta` is arbitrary,
 * caller-controlled YAML/JSON data bounded only by `maxResponseBytes`
 * (10MB default), so a metadata-heavy/markdown-light page could occupy
 * close to that per cache entry while being charged almost nothing
 * against `maxPageCacheBytes` - defeating the exact aggregate-memory
 * protection that option exists for (see its doc comment).
 *
 * `JSON.stringify` can throw on a circular object graph. YAML supports
 * anchors/aliases (e.g. `a: &x\n  b: *x`), which js-yaml (via
 * gray-matter) happily turns into a genuinely self-referential JS
 * object - so this isn't just a theoretical concern for
 * attacker-controlled frontmatter. Rather than let that throw escape a
 * cache `set()` call, fall back to `maxResponseBytes` as a deliberately
 * conservative (never-under-counting) estimate: the response that
 * produced this page was already capped to that many bytes, so it's a
 * safe upper bound regardless of the object's shape. `toc` is always
 * built fresh from parsed markdown headings (see `extractToc()`), never
 * aliased from untrusted input, so it can't be circular.
 */
function pageContentSize(page: PageContent, maxResponseBytes: number): number {
  let metaSize: number;
  try {
    metaSize = JSON.stringify(page.meta).length;
  } catch {
    metaSize = maxResponseBytes;
  }
  return (
    page.markdown.length +
    page.title.length +
    (page.description?.length ?? 0) +
    metaSize +
    JSON.stringify(page.toc).length
  );
}

function extractTitle(markdown: string): string | undefined {
  // Per-line, greedy-to-end-anchor match instead of the old
  // `/^#\s+(.+?)\s*$/m` - a lazy group immediately followed by `\s*$`
  // is the same catastrophic-backtracking shape fixed in
  // src/lib/markdown.ts (see its comment for the empirical timings).
  // `(.*)$` has nothing after it to backtrack against, so it's linear
  // regardless of line length; the loop preserves the original's
  // "skip a bare '#' line with no real content, keep scanning" behavior.
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#\s+(.*)$/.exec(line);
    if (!m) continue;
    const title = m[1]!.trim();
    if (title) return title;
  }
  return undefined;
}

function extractHtmlMeta(html: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const title = extractTagText(html, 'title');
  if (title !== null) meta.title = decodeHtml(title.trim());
  // Note: the description/og:title regexes below use `[^"']*` (bounded
  // by the surrounding quote characters, which the pattern's own literal
  // prefix already contains) rather than `[^>]*` - empirically verified
  // this doesn't reproduce the same quadratic blowup as the title regex
  // did, since any two adjacent "attempts" are always within a small,
  // constant distance of each other's quote characters. Left as-is.
  const descMatch =
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(html) ??
    /<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i.exec(html);
  if (descMatch) meta.description = decodeHtml(descMatch[1]!);
  const ogTitle = /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i.exec(html);
  if (ogTitle && !meta.title) meta.title = decodeHtml(ogTitle[1]!);
  return meta;
}

/**
 * Extract the text content of the first `<tag>...</tag>` in `html`,
 * without the classic `<tag[^>]*>([^<]*)<\/tag>` regex's quadratic
 * blowup on adversarial input with no reachable closing `>` (the same
 * class of bug as `html-to-md.ts`'s `findLargestTagBlock` - see its doc
 * comment for the full mechanism). Empirically confirmed: the original
 * title regex alone took ~5.3s against 200KB of "<title" repeated with
 * no ">" anywhere, scaling quadratically.
 *
 * Uses a *bounded* regex (`<tag\b`, no unbounded quantifier) to find the
 * opening tag, then `String.indexOf` (never backtracks) to find first
 * the opening tag's closing `>`, then the `</tag>` closer. Returns
 * `null` (no title) if there's no opening tag, no closing `>` for it, no
 * `</tag>` after that, or - matching the original `[^<]*` capture's
 * semantics - if a stray `<` appears before the real closer.
 */
function extractTagText(html: string, tag: string): string | null {
  const openMatch = new RegExp(`<${tag}\\b`, 'i').exec(html);
  if (!openMatch) return null;
  const openEnd = html.indexOf('>', openMatch.index + openMatch[0].length);
  if (openEnd === -1) return null;
  const contentStart = openEnd + 1;
  const closeRe = new RegExp(`<\\/${tag}>`, 'gi');
  closeRe.lastIndex = contentStart;
  const closeMatch = closeRe.exec(html);
  if (!closeMatch) return null;
  const strayAngle = html.indexOf('<', contentStart);
  if (strayAngle !== -1 && strayAngle < closeMatch.index) return null;
  return html.slice(contentStart, closeMatch.index);
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * The Fumadocs/Orama search API has slightly different response shapes
 * depending on the version and configuration. This handles the common ones:
 *   - Array of { url, content, type, ... }
 *   - { hits: [{ document: {...} }] }
 *   - { results: [...] }
 */
function parseSearchResponse(data: unknown): SearchHit[] {
  const hits: SearchHit[] = [];
  const push = (h: Partial<SearchHit>) => {
    if (!h.url || !h.title) return;
    hits.push({
      url: h.url,
      title: h.title,
      ...(h.description ? { description: h.description } : {}),
      ...(h.excerpt ? { excerpt: h.excerpt } : {}),
      ...(typeof h.score === 'number' ? { score: h.score } : {}),
      ...(h.tag ? { tag: h.tag } : {}),
    });
  };
  if (Array.isArray(data)) {
    for (const item of data) collectFumadocsHit(item, push);
    return hits;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const hitsArr = (obj.hits ?? obj.results ?? obj.data) as unknown;
    if (Array.isArray(hitsArr)) {
      for (const item of hitsArr) collectFumadocsHit(item, push);
    }
  }
  return hits;
}

function collectFumadocsHit(
  item: unknown,
  push: (h: Partial<SearchHit>) => void,
): void {
  if (!item || typeof item !== 'object') return;
  const it = item as Record<string, unknown>;
  // Orama wraps hits as { document, score }
  const doc = (it.document as Record<string, unknown> | undefined) ?? it;
  // These are untrusted values from an external search API response - see
  // asNonEmptyString's doc comment for why we don't use an `as string` cast.
  const url = asNonEmptyString(doc.url) ?? asNonEmptyString(doc.id);
  const title = asNonEmptyString(doc.title) ?? asNonEmptyString(doc.heading);
  if (!url || !title) return;
  push({
    url,
    title,
    description: asNonEmptyString(doc.description),
    excerpt: asNonEmptyString(doc.content) ?? asNonEmptyString(doc.excerpt),
    score: (it.score as number | undefined) ?? (doc.score as number | undefined),
    tag: asNonEmptyString(doc.tag),
  });
}
