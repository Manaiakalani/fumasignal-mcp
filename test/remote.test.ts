import { describe, it, expect } from 'vitest';
import { RemoteFumadocsSource } from '../src/sources/remote.js';

/** Build a fake fetch that responds based on URL→{status, body, contentType}. */
function makeFetch(
  routes: Record<
    string,
    { status?: number; body: string; contentType?: string; headers?: Record<string, string> }
  >,
) {
  return async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // Normalize: ignore query
    const noQuery = url.split('?')[0]!;
    const route = routes[url] ?? routes[noQuery];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? 'text/plain', ...route.headers },
    });
  };
}

describe('RemoteFumadocsSource', () => {
  const baseUrl = 'https://example.com';
  const sitemap = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/docs/intro</loc></url>
  <url><loc>https://example.com/docs/api/auth</loc></url>
  <url><loc>https://example.com/blog/post</loc></url>
</urlset>`;

  it('lists pages from sitemap filtered by docs prefix', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/sitemap.xml': { body: sitemap, contentType: 'application/xml' },
      }),
    });
    const pages = await src.listPages();
    expect(pages.map((p) => p.url).sort()).toEqual(['/docs/api/auth', '/docs/intro']);
  });

  it('parses Orama-style search responses', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/api/search?query=hello': {
          body: JSON.stringify([
            { url: '/docs/intro', title: 'Intro', content: 'hello world', type: 'page' },
            { url: '/docs/api/auth', title: 'Auth', content: 'auth', type: 'page' },
          ]),
          contentType: 'application/json',
        },
      }),
    });
    const hits = await src.search({ query: 'hello' });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.url).toBe('/docs/intro');
  });

  it('parses {hits:[{document}]} search responses', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/api/search?query=auth': {
          body: JSON.stringify({
            hits: [
              { document: { url: '/docs/api/auth', title: 'Auth', description: 'OAuth flows' }, score: 0.9 },
            ],
          }),
          contentType: 'application/json',
        },
      }),
    });
    const hits = await src.search({ query: 'auth' });
    expect(hits[0]!.title).toBe('Auth');
    expect(hits[0]!.score).toBe(0.9);
  });

  it('drops a search hit with a non-string title, and omits a non-string description rather than crashing', async () => {
    // Regression: collectFumadocsHit() used bare `as string | undefined`
    // casts on an external search API's JSON. A numeric title/description
    // wouldn't crash (template literals coerce), but would silently render
    // as e.g. "42" instead of being treated as missing.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/api/search?query=x': {
          body: JSON.stringify([
            { url: '/docs/bad-title', title: 42, content: 'has a numeric title' },
            { url: '/docs/good', title: 'Good', description: 42, content: 'has a numeric description' },
          ]),
          contentType: 'application/json',
        },
      }),
    });
    const hits = await src.search({ query: 'x' });
    expect(hits.map((h) => h.url)).toEqual(['/docs/good']);
    expect(hits[0]!.description).toBeUndefined();
  });

  it('fetches markdown via .md endpoint when available', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/intro.md': {
          body: `---\ntitle: Intro\n---\n\n# Intro\n\nbody`,
          contentType: 'text/markdown',
        },
      }),
    });
    const page = await src.getPage('/docs/intro');
    expect(page.title).toBe('Intro');
    expect(page.markdown).toContain('body');
    expect(page.toc.find((t) => t.anchor === 'intro')).toBeDefined();
  });

  it('falls back to the markdown heading when frontmatter title is a non-string YAML value', async () => {
    // Regression: getPage() used `(meta.title as string | undefined)`,
    // unlike the equivalent guard already added to local.ts's buildIndex().
    // A YAML title of `42` parses as a number; it must not silently become
    // the page's displayed title, and description must not either.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/numeric.md': {
          body: `---\ntitle: 42\ndescription: true\n---\n\n# Real Heading\n\nbody text`,
          contentType: 'text/markdown',
        },
      }),
    });
    const page = await src.getPage('/docs/numeric');
    expect(page.title).toBe('Real Heading');
    expect(page.description).toBeUndefined();
  });

  it('falls back to HTML scrape when markdown is unavailable', async () => {
    const html = `<!doctype html><html><head><title>Hello</title>
<meta name="description" content="hi"></head>
<body><nav>nav junk</nav><main><article><h1>Hello</h1><p>This is the body.</p><h2>More</h2><p>more text here that should appear in markdown output</p></article></main></body></html>`;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/intro': { body: html, contentType: 'text/html' },
      }),
    });
    const page = await src.getPage('/docs/intro');
    expect(page.title).toBe('Hello');
    expect(page.markdown).toContain('Hello');
    expect(page.markdown).toContain('more text here');
    expect(page.markdown).not.toContain('nav junk');
  });

  it('returns null for missing llms.txt', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({}),
    });
    expect(await src.getLlmsTxt()).toBeNull();
  });

  it('returns llms.txt content when present', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/llms.txt': { body: '# Site Map\n- /docs', contentType: 'text/plain' },
      }),
    });
    expect(await src.getLlmsTxt()).toBe('# Site Map\n- /docs');
  });

  it('refuses cross-origin refs', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({}),
    });
    await expect(src.getPage('https://evil.com/docs/x')).rejects.toThrow(/cross-origin/i);
  });

  it('refuses protocol-relative refs that resolve to a different host', async () => {
    // Regression: new URL('//evil.com/x', base) resolves host to "evil.com",
    // but the old resolveRef() only host-checked the absolute-URL branch,
    // not the "starts with /" branch that protocol-relative refs fall into.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({}),
    });
    await expect(src.getPage('//evil.com/steal')).rejects.toThrow(/cross-origin/i);
  });

  it('transparently follows a same-origin redirect', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/llms.txt': {
          status: 302,
          body: '',
          headers: { location: '/llms-real.txt' },
        },
        'https://example.com/llms-real.txt': { body: 'real content', contentType: 'text/plain' },
      }),
    });
    expect(await src.getLlmsTxt()).toBe('real content');
  });

  it('refuses to follow a redirect to a different origin', async () => {
    // Regression: fetch() follows redirects by default, which would let a
    // same-origin URL 30x-redirect to an attacker host while still
    // attaching our Authorization/UA headers. fetchSameOrigin must
    // validate every hop, not just the initial URL.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/llms.txt': {
          status: 302,
          body: '',
          headers: { location: 'https://evil.com/steal' },
        },
      }),
    });
    await expect(src.getLlmsTxt()).rejects.toThrow(/cross-origin/i);
  });

  it('refuses a same-host redirect that downgrades from https to http', async () => {
    // Regression: comparing `.host` (hostname[:port], no protocol) instead
    // of `.origin` would let an https base redirect to the identical
    // hostname over plain http, silently leaking the Authorization header
    // in cleartext. `.host` treats these as equal; `.origin` does not.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/llms.txt': {
          status: 302,
          body: '',
          headers: { location: 'http://example.com/llms.txt' },
        },
      }),
    });
    await expect(src.getLlmsTxt()).rejects.toThrow(/cross-origin/i);
  });

  it('enforces maxResponseBytes and rejects an oversized response body', async () => {
    // Regression: an unbounded/lied-about Content-Length (or chunked body)
    // from a compromised or malicious upstream could exhaust memory.
    // readCappedText() streams the body and aborts once the configured
    // cap is exceeded, regardless of what Content-Length claims.
    const bigBody = 'x'.repeat(1000);
    const src = new RemoteFumadocsSource({
      baseUrl,
      maxResponseBytes: 100,
      fetchImpl: makeFetch({
        'https://example.com/llms.txt': { body: bigBody, contentType: 'text/plain' },
      }),
    });
    await expect(src.getLlmsTxt()).rejects.toThrow(/exceeded/i);
  });

  it('allows a response body under the maxResponseBytes cap', async () => {
    const src = new RemoteFumadocsSource({
      baseUrl,
      maxResponseBytes: 100,
      fetchImpl: makeFetch({
        'https://example.com/llms.txt': { body: 'small body', contentType: 'text/plain' },
      }),
    });
    expect(await src.getLlmsTxt()).toBe('small body');
  });

  it('does not eval() a remote page frontmatter tagged with a javascript engine, and falls back to HTML scraping', async () => {
    // Malformed/dangerous frontmatter on the markdown-flavored URL must not
    // crash the whole page fetch - it should fall through to the next
    // candidate (or the HTML scrape below), the same way a plain YAML
    // syntax error would. The critical property is that the eval never
    // runs, not that the call rejects.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/evil.md': {
          body: `---javascript\nglobalThis.__fumasignal_pwned_remote = true;\n---\n\nbody`,
          contentType: 'text/markdown',
        },
        'https://example.com/docs/evil': {
          body: '<html><body><article><h1>Evil</h1><p>safe html fallback</p></article></body></html>',
          contentType: 'text/html',
        },
      }),
    });
    try {
      const page = await src.getPage('/docs/evil');
      expect(page.markdown).toContain('safe html fallback');
      expect((globalThis as Record<string, unknown>).__fumasignal_pwned_remote).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).__fumasignal_pwned_remote;
    }
  });

  it('does not match a sibling prefix when filtering listPages', async () => {
    const siblingSitemap = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/docs/api/auth</loc></url>
  <url><loc>https://example.com/docs/api2/other</loc></url>
</urlset>`;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/sitemap.xml': { body: siblingSitemap, contentType: 'application/xml' },
      }),
    });
    const pages = await src.listPages('/docs/api');
    expect(pages.map((p) => p.url)).toEqual(['/docs/api/auth']);
  });
});
