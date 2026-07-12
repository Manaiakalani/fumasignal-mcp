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

  it('recurses into a sitemap index and aggregates pages from nested sitemaps', async () => {
    // Regression: large/sharded sites often serve a <sitemapindex> whose
    // <loc> entries point to OTHER sitemaps, not pages. Previously
    // unhandled: parseSitemap() would extract those sub-sitemap URLs as if
    // they were page URLs, filterToDocs() would reject them (they don't
    // match docsPrefix), and listPages() would silently return zero pages.
    const indexXml = `<?xml version="1.0"?>
<sitemapindex>
  <loc>https://example.com/sitemap-a.xml</loc>
  <loc>https://example.com/sitemap-b.xml</loc>
</sitemapindex>`;
    const sitemapA = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/docs/a1</loc></url>
</urlset>`;
    const sitemapB = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/docs/b1</loc></url>
</urlset>`;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/sitemap.xml': { body: indexXml, contentType: 'application/xml' },
        'https://example.com/sitemap-a.xml': { body: sitemapA, contentType: 'application/xml' },
        'https://example.com/sitemap-b.xml': { body: sitemapB, contentType: 'application/xml' },
      }),
    });
    const pages = await src.listPages();
    expect(pages.map((p) => p.url).sort()).toEqual(['/docs/a1', '/docs/b1']);
  });

  it('skips a nested sitemap that fails to fetch, rather than failing listPages entirely', async () => {
    const indexXml = `<?xml version="1.0"?>
<sitemapindex>
  <loc>https://example.com/sitemap-a.xml</loc>
  <loc>https://example.com/sitemap-missing.xml</loc>
</sitemapindex>`;
    const sitemapA = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/docs/a1</loc></url>
</urlset>`;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/sitemap.xml': { body: indexXml, contentType: 'application/xml' },
        'https://example.com/sitemap-a.xml': { body: sitemapA, contentType: 'application/xml' },
        // sitemap-missing.xml intentionally absent -> fetchImpl 404s it
      }),
    });
    const pages = await src.listPages();
    expect(pages.map((p) => p.url)).toEqual(['/docs/a1']);
  });

  it('bounds recursion depth on a self-referential sitemap index instead of hanging', async () => {
    // A sitemap index whose single entry points back to itself. The depth
    // guard (MAX_SITEMAP_INDEX_DEPTH) must stop this quickly rather than
    // relying solely on the total-fetch-count guard, which would take many
    // more sequential round-trips to kick in on a single-child chain.
    const selfIndexXml = `<?xml version="1.0"?>
<sitemapindex>
  <loc>https://example.com/sitemap.xml</loc>
</sitemapindex>`;
    let fetchCalls = 0;
    const baseFetch = makeFetch({
      'https://example.com/sitemap.xml': { body: selfIndexXml, contentType: 'application/xml' },
    });
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input, init) => {
        fetchCalls++;
        return baseFetch(input, init);
      },
    });
    const pages = await src.listPages();
    expect(pages).toEqual([]);
    // Depth-bounded: a handful of hops (depth limit + 1), nowhere near the
    // 200-fetch total budget.
    expect(fetchCalls).toBeLessThan(10);
  });

  it('bounds total sitemap fetches on wide fan-out instead of fetching every shard', async () => {
    // A single-level index with far more children than the total-fetch
    // budget allows. The depth guard alone wouldn't help here (depth
    // never exceeds 1) - this exercises the shared fetch-count budget.
    const subCount = 250;
    const routes: Record<string, { body: string; contentType?: string }> = {
      'https://example.com/sitemap.xml': {
        body: `<?xml version="1.0"?>\n<sitemapindex>\n${Array.from(
          { length: subCount },
          (_, i) => `  <loc>https://example.com/sitemap-${i}.xml</loc>`,
        ).join('\n')}\n</sitemapindex>`,
        contentType: 'application/xml',
      },
    };
    for (let i = 0; i < subCount; i++) {
      routes[`https://example.com/sitemap-${i}.xml`] = {
        body: `<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://example.com/docs/page-${i}</loc></url>\n</urlset>`,
        contentType: 'application/xml',
      };
    }
    let fetchCalls = 0;
    const baseFetch = makeFetch(routes);
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input, init) => {
        fetchCalls++;
        return baseFetch(input, init);
      },
    });
    const pages = await src.listPages();
    expect(fetchCalls).toBeLessThanOrEqual(200);
    expect(pages.length).toBeLessThan(subCount);
  });

  it('evicts least-recently-used pages from pageCache once maxPageCacheBytes is exceeded', async () => {
    // Regression: without a byte budget, up to 500 (default maxEntries)
    // cached pages could each hold up to maxResponseBytes of markdown,
    // letting aggregate pageCache memory grow to ~5GB worst case.
    // maxPageCacheBytes bounds the *combined* size of cached markdown.
    let fetchCount = 0;
    const baseFetch = makeFetch({
      'https://example.com/docs/a.md': { body: `# A\n\n${'x'.repeat(20)}`, contentType: 'text/markdown' },
      'https://example.com/docs/b.md': { body: `# B\n\n${'x'.repeat(20)}`, contentType: 'text/markdown' },
    });
    const src = new RemoteFumadocsSource({
      baseUrl,
      maxPageCacheBytes: 30, // smaller than the combined size of both pages' markdown (~25 each)
      fetchImpl: async (input, init) => {
        fetchCount++;
        return baseFetch(input, init);
      },
    });
    await src.getPage('/docs/a');
    await src.getPage('/docs/b'); // pushes combined size over budget -> evicts 'a'
    const afterTwoFetches = fetchCount;
    await src.getPage('/docs/a'); // must re-fetch over the network since 'a' was evicted
    expect(fetchCount).toBeGreaterThan(afterTwoFetches);
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

  it('refuses a same-origin ref outside the configured docs prefix', async () => {
    // Regression: same-origin is necessary but not sufficient as an
    // authorization boundary. `ref` is caller-supplied (an MCP tool
    // argument), and if an Authorization header is configured it would be
    // attached to ANY same-origin fetch - so getPage("/api/private") must
    // not be allowed to fetch and return an arbitrary same-origin path
    // just because it shares the configured origin.
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: 'Bearer secret-token',
      fetchImpl: makeFetch({
        'https://example.com/api/private': { body: 'top secret', contentType: 'text/plain' },
      }),
    });
    await expect(src.getPage('/api/private')).rejects.toThrow(/docs prefix/i);
  });

  it('allows a ref exactly at the docs prefix root', async () => {
    // The docs-prefix check must not reject the prefix itself (e.g. "/docs"
    // exactly, with no trailing segment) - only paths outside of it.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs.md': { body: '# Docs Root\n\nbody', contentType: 'text/markdown' },
      }),
    });
    const page = await src.getPage('/docs');
    expect(page.title).toBe('Docs Root');
  });

  it('refuses a same-origin redirect that leaves the configured docs prefix', async () => {
    // Regression: the initial ref passing the docsPrefix check in
    // resolveRef() isn't enough on its own - a same-origin redirect could
    // still carry a page fetch outside docsPrefix (e.g. to an internal
    // API), still attaching the Authorization header. fetchSameOrigin's
    // pathPrefix option must re-check every hop, not just the first.
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: 'Bearer secret-token',
      fetchImpl: makeFetch({
        'https://example.com/docs/redir.md': {
          status: 302,
          body: '',
          headers: { location: '/api/private' },
        },
        'https://example.com/api/private': { body: 'top secret', contentType: 'text/plain' },
      }),
    });
    await expect(src.getPage('/docs/redir')).rejects.toThrow(/docs prefix/i);
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
