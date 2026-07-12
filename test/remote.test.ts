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

  it('fetches a sub-sitemap only once even if it is listed multiple times in one sitemap index', async () => {
    // Regression: fetchSitemapUrls() previously had no visited-set (only
    // a fetch-count budget), so a <sitemapindex> listing the same
    // sub-sitemap <loc> multiple times would re-fetch and re-parse it
    // every time - wasting the shared MAX_SITEMAP_FETCHES budget on
    // redundant work instead of genuinely distinct sitemaps, and
    // re-appending its full URL list each time.
    const indexXml = `<?xml version="1.0"?>
<sitemapindex>
  <loc>https://example.com/sitemap-a.xml</loc>
  <loc>https://example.com/sitemap-a.xml</loc>
  <loc>https://example.com/sitemap-a.xml</loc>
</sitemapindex>`;
    const sitemapA = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/docs/a1</loc></url>
</urlset>`;
    let fetchCalls = 0;
    let sitemapAFetches = 0;
    const baseFetch = makeFetch({
      'https://example.com/sitemap.xml': { body: indexXml, contentType: 'application/xml' },
      'https://example.com/sitemap-a.xml': { body: sitemapA, contentType: 'application/xml' },
    });
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input, init) => {
        fetchCalls++;
        const url = (typeof input === 'string' ? input : input.toString()).split('?')[0];
        if (url === 'https://example.com/sitemap-a.xml') sitemapAFetches++;
        return baseFetch(input, init);
      },
    });
    const pages = await src.listPages();
    expect(sitemapAFetches).toBe(1);
    expect(fetchCalls).toBe(2); // 1 for the index + 1 for sitemap-a (deduped)
    expect(pages.map((p) => p.url)).toEqual(['/docs/a1']);
  });

  it('dedups the final page list when the same page appears more than once in a sitemap', async () => {
    // Regression: filterToDocs()/listPages() never deduped the final page
    // list - a repeated <loc> within one sitemap (or the same page
    // legitimately listed more than once) would inflate the
    // returned/cached list with duplicate entries.
    const sitemapWithDup = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://example.com/docs/dup</loc></url>
  <url><loc>https://example.com/docs/dup</loc></url>
  <url><loc>https://example.com/docs/other</loc></url>
</urlset>`;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/sitemap.xml': { body: sitemapWithDup, contentType: 'application/xml' },
      }),
    });
    const pages = await src.listPages();
    expect(pages.map((p) => p.url).sort()).toEqual(['/docs/dup', '/docs/other']);
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

  it('bounds total accumulated URLs even when each shard is itself huge (cache-OOM regression)', async () => {
    // Regression: MAX_SITEMAP_FETCHES only bounds the *number* of HTTP
    // requests. Without an independent cap on the accumulated *URL
    // count*, a malicious/compromised site could fan out to the
    // fetch-count budget with each leaf sitemap packed with as many
    // <loc> entries as fit under maxResponseBytes, producing a
    // multi-hundred-MB to multi-GB in-memory list held indefinitely in
    // listCache. Empirically confirmed pre-fix: 20 shards x 50k URLs
    // (1M URLs) grew the heap by ~608MB, extrapolating to ~6GB at the
    // real 200-fetch budget. Use a smaller but still generous
    // per-shard count here so the test stays fast.
    const subCount = 5;
    const urlsPerShard = 80_000;
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
      const urls = Array.from(
        { length: urlsPerShard },
        (_, j) => `<url><loc>https://example.com/docs/s${i}-p${j}</loc></url>`,
      ).join('\n');
      routes[`https://example.com/sitemap-${i}.xml`] = {
        body: `<?xml version="1.0"?>\n<urlset>\n${urls}\n</urlset>`,
        contentType: 'application/xml',
      };
    }
    const src = new RemoteFumadocsSource({ baseUrl, fetchImpl: makeFetch(routes) });
    const pages = await src.listPages();
    // subCount * urlsPerShard = 400,000 - well beyond MAX_SITEMAP_URLS
    // (200,000), so the cap must have kicked in rather than returning
    // everything.
    expect(pages.length).toBeLessThanOrEqual(200_000);
    expect(pages.length).toBeLessThan(subCount * urlsPerShard);
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

  it('counts frontmatter/meta size toward maxPageCacheBytes, not just markdown length', async () => {
    // Regression: pageCache's sizeOf used to be `page.markdown.length`
    // only, ignoring meta/title/description/toc entirely. A page with
    // near-zero markdown but a huge frontmatter block could occupy
    // megabytes of memory while registering as ~0 bytes against
    // maxPageCacheBytes - the "500 metadata-heavy pages -> ~5GB" scenario
    // maxPageCacheBytes's own doc comment warns about. pageContentSize()
    // must count meta too, so this budget (far larger than either page's
    // tiny markdown, but smaller than two pages' combined frontmatter)
    // still triggers eviction.
    const bigFrontmatter = 'x'.repeat(300);
    let fetchCount = 0;
    const baseFetch = makeFetch({
      'https://example.com/docs/a.md': {
        body: `---\ntitle: A\nextra: "${bigFrontmatter}"\n---\n\ntiny`,
        contentType: 'text/markdown',
      },
      'https://example.com/docs/b.md': {
        body: `---\ntitle: B\nextra: "${bigFrontmatter}"\n---\n\ntiny`,
        contentType: 'text/markdown',
      },
    });
    const src = new RemoteFumadocsSource({
      baseUrl,
      // Markdown alone ("tiny", 4 bytes) would never trip this budget -
      // only counting the frontmatter too does.
      maxPageCacheBytes: 350,
      fetchImpl: async (input, init) => {
        fetchCount++;
        return baseFetch(input, init);
      },
    });
    await src.getPage('/docs/a');
    await src.getPage('/docs/b'); // combined meta size pushes over budget -> evicts 'a'
    const afterTwoFetches = fetchCount;
    await src.getPage('/docs/a'); // must re-fetch since 'a' was evicted
    expect(fetchCount).toBeGreaterThan(afterTwoFetches);
  });

  it('does not crash when a page has circular-reference frontmatter (YAML anchors/aliases)', async () => {
    // Regression (superseded by a more thorough fix - see below): this
    // originally tested that pageContentSize()'s try/catch around
    // JSON.stringify(page.meta) kept the cache-accounting path alive
    // when frontmatter contained a genuine self-reference, while leaving
    // the circular structure itself intact on page.meta. That approach
    // only protected pageContentSize() - the get_page/get_meta tool
    // handlers each call JSON.stringify(page.meta / meta) directly too,
    // and would independently throw (surfacing as a tool error, not a
    // crash, but still a failure) on the same input; separately, a YAML
    // anchor/alias *DAG* (no true cycle, just heavy reference reuse -
    // "billion laughs") doesn't throw at all and instead amplifies to a
    // huge string. `parseFrontmatter()` now sanitizes at the source
    // (see frontmatter.test.ts for that coverage in detail), replacing
    // both true cycles and oversized DAGs with a small placeholder
    // before `page.meta` is ever populated - so a genuine self-reference
    // no longer survives into `page.meta` at all, and every consumer
    // (not just pageContentSize()) is protected uniformly.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/circular.md': {
          body: `---\na: &anchor\n  b: *anchor\n---\n\n# Circular\n\nbody`,
          contentType: 'text/markdown',
        },
      }),
    });
    const page = await src.getPage('/docs/circular');
    expect(page.title).toBe('Circular');
    // The cycle is neutralized to a placeholder rather than preserved -
    // safe to JSON.stringify anywhere page.meta is consumed.
    expect((page.meta.a as Record<string, unknown>).b).toBe('[circular reference]');
    expect(() => JSON.stringify(page.meta)).not.toThrow();
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

  it('does not let a query-bearing ref poison the plain-path cache entry (cache-key regression)', async () => {
    // Regression: getPage() used to cache solely on `target.pathname`, but
    // fetchPageBody()'s HTML-scrape fallback fetches `target` *with* its
    // query string intact - so a response that legitimately varies by
    // query (e.g. a preview/variant flag) got cached under the same key
    // as the plain path, and a later plain-path request incorrectly
    // received the query-specific response instead of fetching its own.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('.md') || url.endsWith('.mdx') || url.endsWith('/raw') || url.endsWith('/index.md')) {
          return new Response('not found', { status: 404 });
        }
        if (url === 'https://example.com/docs/guide?variant=private') {
          return new Response('<html><body><article>PRIVATE CONTENT</article></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (url === 'https://example.com/docs/guide') {
          return new Response('<html><body><article>PUBLIC CONTENT</article></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const privatePage = await src.getPage('/docs/guide?variant=private');
    expect(privatePage.markdown).toContain('PRIVATE CONTENT');
    const plainPage = await src.getPage('/docs/guide');
    expect(plainPage.markdown).toContain('PUBLIC CONTENT');
    expect(plainPage.markdown).not.toContain('PRIVATE CONTENT');
  });

  it('coalesces concurrent getPage() misses for the same ref into one fetch chain', async () => {
    // Regression: concurrent cache-miss callers for the same never-before-
    // fetched ref used to each independently run the full markdown-
    // candidate-then-HTML fetch chain, multiplying upstream requests (and
    // buffered response memory) by the number of concurrent callers.
    let fetchCount = 0;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://example.com/docs/guide.md') {
          return new Response('# Guide\n\nbody', {
            status: 200,
            headers: { 'content-type': 'text/markdown' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const [a, b, c] = await Promise.all([
      src.getPage('/docs/guide'),
      src.getPage('/docs/guide'),
      src.getPage('/docs/guide'),
    ]);
    expect(a.title).toBe('Guide');
    expect(b.title).toBe('Guide');
    expect(c.title).toBe('Guide');
    expect(fetchCount).toBe(1);
  });

  it('coalesces concurrent listPages() misses into one sitemap traversal', async () => {
    let fetchCount = 0;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://example.com/sitemap.xml') {
          return new Response(sitemap, { status: 200, headers: { 'content-type': 'application/xml' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const [a, b] = await Promise.all([src.listPages(), src.listPages()]);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    expect(fetchCount).toBe(1);
  });

  it('coalesces concurrent getLlmsTxt() misses into one fetch', async () => {
    let fetchCount = 0;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://example.com/llms.txt') {
          return new Response('llms content', { status: 200, headers: { 'content-type': 'text/plain' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const [a, b] = await Promise.all([src.getLlmsTxt(), src.getLlmsTxt()]);
    expect(a).toBe('llms content');
    expect(b).toBe('llms content');
    expect(fetchCount).toBe(1);
  });

  it('extracts the title from HTML in bounded time despite adversarial "<title" input with no ">" anywhere', async () => {
    // Regression: the original title regex (`<title[^>]*>([^<]*)<\/title>`)
    // had an independent, unbounded backtracking blowup - on input with
    // many "<title" occurrences and no reachable ">", each attempt scans
    // to the end of the string before failing, repeated at every position
    // -> O(n^2), even for a single non-global .exec(). Empirically ~5.3s
    // for 200KB before the fix; extractTagText() must resolve this in
    // bounded (roughly linear) time.
    const adversarial = '<title'.repeat(50_000);
    const html = `<!doctype html><head>${adversarial}</head><body><article><h1>Real</h1><p>content that should appear in the markdown output</p></article></body></html>`;
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/slow': { body: html, contentType: 'text/html' },
      }),
    });
    const start = Date.now();
    const page = await src.getPage('/docs/slow');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(page.markdown).toContain('content that should appear');
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

  it('rejects a percent-encoded path-traversal ref that would escape the docs prefix', async () => {
    // Regression (CWE-22): the WHATWG URL parser collapses *literal* "."
    // / ".." segments while parsing, but leaves percent-encoded ones
    // ("%2e%2e%2f") untouched in .pathname - hasPathPrefix()'s plain
    // string-prefix check was fooled by this, since "/docs/%2e%2e%2fapi/private"
    // starts with "/docs" even though it decodes+normalizes to
    // "/api/private", outside the configured prefix.
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: '******',
      fetchImpl: makeFetch({
        'https://example.com/api/private': { body: 'top secret', contentType: 'text/plain' },
      }),
    });
    await expect(src.getPage('/docs/%2e%2e%2fapi/private')).rejects.toThrow(/docs prefix/i);
  });

  it('rejects a ref hiding a double-encoded separator ("%252f")', async () => {
    // Regression (CWE-22): decodeURIComponent only unwraps one encoding
    // layer, so "%252f" (which is "%2f" with its own "%" encoded) decodes
    // to the literal text "%2f" - which the WHATWG URL parser leaves
    // alone while parsing (it never decodes "%2f" into a real "/"). That
    // makes "/docs/..%252fapi/private" normalize to one harmless-looking
    // segment and pass hasPathPrefix(), yet the exact literal pathname
    // "/docs/..%2fapi/private" is what actually gets fetched - and many
    // real HTTP servers decode "%2f" while resolving *their* request
    // path, which would resolve outside "/docs".
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: '******',
      fetchImpl: makeFetch({
        'https://example.com/api/private': { body: 'top secret', contentType: 'text/plain' },
      }),
    });
    await expect(src.getPage('/docs/..%252fapi/private')).rejects.toThrow(/unresolvable path/i);
  });

  it('rejects a ref hiding a *triple*-encoded separator ("%25252f"), not just double', async () => {
    // Regression: an earlier fix only decoded once and so only caught a
    // *double*-encoded separator, documenting triple-encoding as an
    // "accepted residual" on the theory that a real server would need two
    // *extra* decode passes (beyond the one already unwrapped) to exploit
    // it. A follow-up audit reproduced exactly that against a simulated
    // double-decoding upstream, so this now decodes to a fixed point and
    // checks every intermediate pass instead of stopping after one -
    // closing the class at any depth, not just N=2.
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: '******',
      fetchImpl: makeFetch({
        'https://example.com/api/private': { body: 'top secret', contentType: 'text/plain' },
      }),
    });
    await expect(src.getPage('/docs/..%25252fapi/private')).rejects.toThrow(/unresolvable path/i);
    await expect(src.getPage('/docs/..%2525252fapi/private')).rejects.toThrow(/unresolvable path/i);
  });

  it('rejects a ref with malformed percent-encoding instead of treating it as a literal path', async () => {
    // Regression: decodeURIComponent throws on malformed percent-encoding
    // (including "overlong" UTF-8 encodings sometimes used to smuggle
    // traversal sequences past naive decoders) - must fail closed rather
    // than silently falling back to the raw, unvalidated pathname.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({}),
    });
    await expect(src.getPage('/docs/%zz')).rejects.toThrow(/unresolvable path/i);
  });

  it('still fetches a page whose ref contains a legitimate percent-encoded character', async () => {
    // The decode+normalize fix must not break legitimate encoded
    // characters that don't involve any "." / ".." segment.
    const src = new RemoteFumadocsSource({
      baseUrl,
      fetchImpl: makeFetch({
        'https://example.com/docs/getting%20started.md': {
          body: '# Getting Started\n\nbody',
          contentType: 'text/markdown',
        },
      }),
    });
    const page = await src.getPage('/docs/getting%20started');
    expect(page.title).toBe('Getting Started');
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

  it('does not send the Authorization header to the root-sibling ".md"/".mdx" candidates when authHeader is configured', async () => {
    // Regression: buildMarkdownCandidates() deliberately produces
    // "/docs.md"/"/docs.mdx" for a target exactly at the docs prefix root
    // - siblings of the docs directory, not descendants of it - and
    // fetchSameOrigin() skips the prefix re-check on the initial (hop-0)
    // fetch to let that convention work. Without also gating those
    // specific candidates on authHeader, a configured Authorization
    // header would be attached to a request outside the authorized
    // docsPrefix boundary, defeating the whole point of that boundary.
    let sawAuthOnSibling = false;
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: 'Bearer secret-token',
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const headers = new Headers(init?.headers);
        if (url === 'https://example.com/docs.md') {
          if (headers.get('authorization')) sawAuthOnSibling = true;
          return new Response('# Docs Root\n\nSECRET-IF-LEAKED', {
            status: 200,
            headers: { 'content-type': 'text/markdown' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    // The sibling candidate is filtered out entirely (not just fetched
    // without credentials), so with nothing else registered the whole
    // call 404s rather than ever touching "/docs.md".
    await expect(src.getPage('/docs')).rejects.toThrow(/page not found/i);
    expect(sawAuthOnSibling).toBe(false);
  });

  it('still fetches an in-prefix candidate (e.g. "/docs/index.md") when authHeader is configured', async () => {
    // The authHeader-gated filter in fetchPageBody() must only remove the
    // two candidates that escape docsPrefix, not every candidate.
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: 'Bearer secret-token',
      fetchImpl: makeFetch({
        'https://example.com/docs/index.md': { body: '# Docs Root\n\nbody', contentType: 'text/markdown' },
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

  it('refuses a redirect Location header containing a percent-encoded path traversal', async () => {
    // Regression: a redirect Location header is just as capable of
    // carrying an encoded traversal segment ("%2e%2e%2f") as a
    // caller-supplied ref - the literal-prefix check on the raw
    // (non-normalized) pathname would miss it, the same way resolveRef's
    // did before the decode+normalize fix.
    const src = new RemoteFumadocsSource({
      baseUrl,
      authHeader: '******',
      fetchImpl: makeFetch({
        'https://example.com/docs/redir.md': {
          status: 302,
          body: '',
          headers: { location: '/docs/%2e%2e%2fapi/private' },
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
