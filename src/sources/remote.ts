import { logger } from '../lib/logger.js';
import { TtlCache } from '../lib/cache.js';
import { htmlToMarkdown } from '../lib/html-to-md.js';
import { extractSection, extractToc } from '../lib/markdown.js';
import { parseFrontmatter, asNonEmptyString } from '../lib/frontmatter.js';
import { filterToDocs, hasPathPrefix, parseSitemap } from '../lib/sitemap.js';
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
}

const DEFAULT_UA = 'fumasignal-mcp/0.1 (+https://github.com/Manaiakalani/fumasignal-mcp)';

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
    const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.pageCache = new TtlCache(ttl);
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
   */
  private async fetchSameOrigin(
    url: URL,
    init: { headers: Record<string, string> },
  ): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (current.origin !== this.base.origin) {
        throw new SourceError(
          `Refusing to fetch cross-origin URL: ${current.origin} (server is bound to ${this.base.origin})`,
        );
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
    const url = new URL(this.searchPath, this.base);
    url.searchParams.set('query', opts.query);
    if (opts.tag) url.searchParams.set('tag', opts.tag);
    if (opts.locale) url.searchParams.set('locale', opts.locale);
    const res = await this.fetchSameOrigin(url, { headers: this.headers() });
    if (!res.ok) {
      throw new SourceError(
        `Search request failed: ${res.status} ${res.statusText} (${url})`,
      );
    }
    const data = JSON.parse(await this.readCappedText(res)) as unknown;
    const hits = parseSearchResponse(data);
    const limit = opts.limit ?? 10;
    return hits.slice(0, limit);
  }

  async listPages(prefix?: string): Promise<PageSummary[]> {
    const cached = this.listCache.get('all');
    let all = cached;
    if (!all) {
      const sitemapUrl = new URL('/sitemap.xml', this.base);
      const res = await this.fetchSameOrigin(sitemapUrl, { headers: this.headers() });
      if (!res.ok) {
        throw new SourceError(
          `Failed to fetch sitemap.xml: ${res.status} ${res.statusText}`,
        );
      }
      const xml = await this.readCappedText(res);
      const urls = parseSitemap(xml);
      const filtered = filterToDocs(urls, this.base.toString(), this.docsPrefix);
      all = filtered.map<PageSummary>(({ url: _url, path }) => ({
        id: path,
        url: path,
        title: titleFromPath(path),
        segments: path.split('/').filter(Boolean),
      }));
      this.listCache.set('all', all);
      logger.debug({ count: all.length }, 'remote: built page list from sitemap');
    }
    if (!prefix) return all;
    return all.filter((p) => hasPathPrefix(p.url, prefix));
  }

  async getPage(ref: string): Promise<PageContent> {
    const target = this.resolveRef(ref);
    const cacheKey = target.pathname;
    const cached = this.pageCache.get(cacheKey);
    if (cached) return cached;

    const { markdown, meta } = await this.fetchPageBody(target);
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
    const url = new URL(path, this.base);
    const res = await this.fetchSameOrigin(url, { headers: this.headers() });
    if (res.status === 404) {
      this.llmsCache.set(path, null);
      return null;
    }
    if (!res.ok) {
      throw new SourceError(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
    }
    const text = await this.readCappedText(res);
    this.llmsCache.set(path, text);
    return text;
  }

  /**
   * Fetch the page body. Try a few markdown-flavored URLs first, then fall
   * back to scraping the rendered HTML. Returns markdown + best-effort meta.
   */
  private async fetchPageBody(
    target: URL,
  ): Promise<{ markdown: string; meta: Record<string, unknown> }> {
    const candidates = buildMarkdownCandidates(target);
    for (const candidate of candidates) {
      const res = await this.fetchSameOrigin(candidate, {
        headers: this.headers({ Accept: 'text/markdown, text/plain;q=0.9' }),
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
        }
      }
    }
    // Fallback: HTML scrape
    const res = await this.fetchSameOrigin(target, { headers: this.headers() });
    if (res.status === 404) {
      throw new NotFoundError(`Page not found: ${target.pathname}`);
    }
    if (!res.ok) {
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

function extractTitle(markdown: string): string | undefined {
  const m = /^#\s+(.+?)\s*$/m.exec(markdown);
  return m ? m[1] : undefined;
}

function extractHtmlMeta(html: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (titleMatch) meta.title = decodeHtml(titleMatch[1]!.trim());
  const descMatch =
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(html) ??
    /<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i.exec(html);
  if (descMatch) meta.description = decodeHtml(descMatch[1]!);
  const ogTitle = /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i.exec(html);
  if (ogTitle && !meta.title) meta.title = decodeHtml(ogTitle[1]!);
  return meta;
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
