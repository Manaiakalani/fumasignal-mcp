import { describe, it, expect } from 'vitest';
import { RemoteFumadocsSource } from '../src/sources/remote.js';

/** Build a fake fetch that responds based on URL→{status, body, contentType}. */
function makeFetch(routes: Record<string, { status?: number; body: string; contentType?: string }>) {
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
      headers: { 'content-type': route.contentType ?? 'text/plain' },
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
});
