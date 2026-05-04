import { describe, it, expect } from 'vitest';
import { parseSitemap, filterToDocs } from '../src/lib/sitemap.js';

describe('parseSitemap', () => {
  it('extracts URLs from a basic sitemap', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/docs/getting-started</loc></url>
  <url><loc>https://example.com/docs/api/auth</loc></url>
  <url><loc>https://other.com/should-not-match</loc></url>
</urlset>`;
    const urls = parseSitemap(xml);
    expect(urls).toHaveLength(4);
  });

  it('handles xml entities', () => {
    const xml = `<urlset><url><loc>https://example.com/a&amp;b</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual(['https://example.com/a&b']);
  });
});

describe('filterToDocs', () => {
  it('keeps only same-host URLs under the prefix', () => {
    const urls = [
      'https://example.com/',
      'https://example.com/docs/x',
      'https://example.com/docs/y/z',
      'https://example.com/blog/post',
      'https://other.com/docs/x',
    ];
    const filtered = filterToDocs(urls, 'https://example.com/', '/docs');
    expect(filtered.map((f) => f.path)).toEqual(['/docs/x', '/docs/y/z']);
  });
});
