import { logger } from '../lib/logger.js';
import { TtlCache } from '../lib/cache.js';
import { htmlToMarkdown } from '../lib/html-to-md.js';
import { extractSection, extractToc } from '../lib/markdown.js';
import { filterToDocs, parseSitemap } from '../lib/sitemap.js';
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

  private resolveUrl(pathOrUrl: string): URL {
    if (/^https?:\/\//i.test(pathOrUrl)) return new URL(pathOrUrl);
    return new URL(pathOrUrl, this.base);
  }

  /** Normalize a "ref" (URL or path or slug) to a same-origin absolute URL. */
  private resolveRef(ref: string): URL {
    if (/^https?:\/\//i.test(ref)) {
      const u = new URL(ref);
      if (u.host !== this.base.host) {
        throw new SourceError(
          `Refusing to fetch cross-origin URL: ${u.origin} (server is bound to ${this.base.origin})`,
        );
      }
      return u;
    }
    if (ref.startsWith('/')) return new URL(ref, this.base);
    // Treat as slug under docsPrefix.
    const path = `${this.docsPrefix.replace(/\/+$/, '')}/${ref.replace(/^\/+/, '')}`;
    return new URL(path, this.base);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const url = new URL(this.searchPath, this.base);
    url.searchParams.set('query', opts.query);
    if (opts.tag) url.searchParams.set('tag', opts.tag);
    if (opts.locale) url.searchParams.set('locale', opts.locale);
    const res = await this.fetchImpl(url.toString(), { headers: this.headers() });
    if (!res.ok) {
      throw new SourceError(
        `Search request failed: ${res.status} ${res.statusText} (${url})`,
      );
    }
    const data = (await res.json()) as unknown;
    const hits = parseSearchResponse(data);
    const limit = opts.limit ?? 10;
    return hits.slice(0, limit);
  }

  async listPages(prefix?: string): Promise<PageSummary[]> {
    const cached = this.listCache.get('all');
    let all = cached;
    if (!all) {
      const sitemapUrl = new URL('/sitemap.xml', this.base).toString();
      const res = await this.fetchImpl(sitemapUrl, { headers: this.headers() });
      if (!res.ok) {
        throw new SourceError(
          `Failed to fetch sitemap.xml: ${res.status} ${res.statusText}`,
        );
      }
      const xml = await res.text();
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
    return all.filter((p) => p.url.startsWith(prefix));
  }

  async getPage(ref: string): Promise<PageContent> {
    const target = this.resolveRef(ref);
    const cacheKey = target.pathname;
    const cached = this.pageCache.get(cacheKey);
    if (cached) return cached;

    const { markdown, meta } = await this.fetchPageBody(target);
    const toc = extractToc(markdown);
    const title = (meta.title as string | undefined) ?? extractTitle(markdown) ?? titleFromPath(target.pathname);
    const description = meta.description as string | undefined;
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
    const url = new URL(path, this.base).toString();
    const res = await this.fetchImpl(url, { headers: this.headers() });
    if (res.status === 404) {
      this.llmsCache.set(path, null);
      return null;
    }
    if (!res.ok) {
      throw new SourceError(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
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
      const res = await this.fetchImpl(candidate.toString(), {
        headers: this.headers({ Accept: 'text/markdown, text/plain;q=0.9' }),
      });
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('markdown') || ct.includes('text/plain')) {
          const text = await res.text();
          const { content, data } = parseFrontmatter(text);
          return { markdown: content, meta: data };
        }
      }
    }
    // Fallback: HTML scrape
    const res = await this.fetchImpl(target.toString(), { headers: this.headers() });
    if (res.status === 404) {
      throw new NotFoundError(`Page not found: ${target.pathname}`);
    }
    if (!res.ok) {
      throw new SourceError(
        `Failed to fetch ${target.pathname}: ${res.status} ${res.statusText}`,
      );
    }
    const html = await res.text();
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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatter(src: string): { content: string; data: Record<string, unknown> } {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { content: src, data: {} };
  const yaml = m[1] ?? '';
  const data: Record<string, unknown> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value: unknown = kv[2]!.trim();
    if (typeof value === 'string') {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else if (value === 'true' || value === 'false') {
        value = value === 'true';
      } else if (value !== '' && !Number.isNaN(Number(value))) {
        value = Number(value);
      }
    }
    data[kv[1]!] = value;
  }
  return { content: src.slice(m[0].length), data };
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
  const url = (doc.url as string | undefined) ?? (doc.id as string | undefined);
  const title =
    (doc.title as string | undefined) ?? (doc.heading as string | undefined);
  if (!url || !title) return;
  push({
    url,
    title,
    description: (doc.description as string | undefined) ?? undefined,
    excerpt:
      (doc.content as string | undefined) ??
      (doc.excerpt as string | undefined) ??
      undefined,
    score: (it.score as number | undefined) ?? (doc.score as number | undefined),
    tag: doc.tag as string | undefined,
  });
}
