import { describe, it, expect } from 'vitest';
import {
  parseSitemap,
  filterToDocs,
  hasPathPrefix,
  decodeAndNormalizePathname,
} from '../src/lib/sitemap.js';

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

  it('stays fast on an adversarial unclosed <loc> with a long run of spaces (ReDoS regression)', () => {
    // Regression: the old pattern `\s*([^<\s][^<]*?)\s*<\/loc>` had a lazy
    // inner quantifier immediately followed by another quantifier
    // matching the same character class - quadratic backtracking on a
    // long run of whitespace with no closing tag. Empirically this took
    // ~5.2s at 80KB before the fix; bound generously at 500ms for a much
    // larger 2MB payload so CI stays robust to slower machines while
    // still catching any regression back to quadratic behavior.
    const xml = `<urlset><loc>${' '.repeat(2_000_000)}`;
    const start = Date.now();
    const urls = parseSitemap(xml);
    expect(Date.now() - start).toBeLessThan(500);
    expect(urls).toEqual([]);
  });
});

describe('decodeAndNormalizePathname', () => {
  it('rejects backslash-encoded traversal that a POSIX normalizer would miss', () => {
    // decodeURIComponent('%5c..%5c..%5capi/private') -> '\..\..\api/private'.
    // A POSIX-only normalizer treats leading "\.." as one harmless
    // segment (no "/"), but the WHATWG URL pathname setter treats "\"
    // as "/" for special schemes, so the *actual* fetch would resolve
    // outside the prefix. The normalized result must reflect that.
    const normalized = decodeAndNormalizePathname('/docs/%5c..%5c..%5capi/private');
    expect(normalized).not.toBeNull();
    expect(hasPathPrefix(normalized!, '/docs')).toBe(false);
  });

  it('rejects double-percent-encoded traversal ("%252e%252e")', () => {
    // decodeURIComponent unwraps exactly one layer: '%252e%252e' -> the
    // literal text '%2e%2e', which a POSIX normalizer doesn't recognize
    // as a dot-segment. The WHATWG URL parser *does* special-case a
    // literal "%2e" segment as "." when parsing a pathname, so the real
    // fetch collapses through it.
    const normalized = decodeAndNormalizePathname('/docs/%252e%252e/admin/secrets');
    expect(normalized).not.toBeNull();
    expect(hasPathPrefix(normalized!, '/docs')).toBe(false);
  });

  it('normalizes an ordinary encoded traversal segment', () => {
    const normalized = decodeAndNormalizePathname('/docs/%2e%2e%2fadmin/secrets');
    expect(normalized).toBe('/admin/secrets');
  });

  it('leaves an ordinary path unchanged', () => {
    expect(decodeAndNormalizePathname('/docs/getting-started')).toBe('/docs/getting-started');
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    expect(decodeAndNormalizePathname('/docs/%')).toBeNull();
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

  it('does not match a sibling path that merely starts with the prefix string', () => {
    // Regression: raw `path.startsWith(prefix)` would wrongly treat
    // "/docs2/x" as being under prefix "/docs".
    const urls = ['https://example.com/docs2/x', 'https://example.com/docs/x'];
    const filtered = filterToDocs(urls, 'https://example.com/', '/docs');
    expect(filtered.map((f) => f.path)).toEqual(['/docs/x']);
  });

  it('excludes a sitemap entry whose encoded traversal decodes outside the prefix', () => {
    // Regression: a raw pathname of "/docs/%2e%2e%2fadmin/secrets" starts
    // with "/docs/" (a naive check would let it through) but decodes +
    // normalizes to "/admin/secrets" - outside docsPrefix. Without
    // decode-before-check, list_pages would leak the existence of
    // out-of-scope paths from a malicious/compromised sitemap.
    const urls = [
      'https://example.com/docs/%2e%2e%2fadmin/secrets',
      'https://example.com/docs/legit',
    ];
    const filtered = filterToDocs(urls, 'https://example.com/', '/docs');
    expect(filtered.map((f) => f.path)).toEqual(['/docs/legit']);
  });

  it('drops a sitemap entry with malformed percent-encoding instead of throwing', () => {
    const urls = ['https://example.com/docs/%', 'https://example.com/docs/legit'];
    expect(() => filterToDocs(urls, 'https://example.com/', '/docs')).not.toThrow();
    const filtered = filterToDocs(urls, 'https://example.com/', '/docs');
    expect(filtered.map((f) => f.path)).toEqual(['/docs/legit']);
  });
});

describe('hasPathPrefix', () => {
  it('matches exact prefix and prefix + "/" boundary', () => {
    expect(hasPathPrefix('/docs', '/docs')).toBe(true);
    expect(hasPathPrefix('/docs/x', '/docs')).toBe(true);
    expect(hasPathPrefix('/docs/x/y', '/docs')).toBe(true);
  });

  it('rejects sibling paths that only share a string prefix', () => {
    expect(hasPathPrefix('/docs2/x', '/docs')).toBe(false);
    expect(hasPathPrefix('/docs-legacy', '/docs')).toBe(false);
    expect(hasPathPrefix('/other', '/docs')).toBe(false);
  });

  it('normalizes a trailing slash on prefix so descendants still match', () => {
    // Regression: a caller-supplied prefix (e.g. the `list_pages` tool's
    // `prefix` argument, which bypasses the CLI's own normalizePrefix())
    // could include a trailing slash. Appending "/" to an
    // already-trailing-slash prefix produced "//" which never matched a
    // real single-slash descendant path, silently returning zero results.
    expect(hasPathPrefix('/docs/x', '/docs/')).toBe(true);
    expect(hasPathPrefix('/docs/x/y', '/docs/')).toBe(true);
    expect(hasPathPrefix('/docs', '/docs/')).toBe(true);
    expect(hasPathPrefix('/docs2/x', '/docs/')).toBe(false);
  });

  it('treats "/" and "" as a no-op filter (matches everything)', () => {
    expect(hasPathPrefix('/anything', '/')).toBe(true);
    expect(hasPathPrefix('/anything', '')).toBe(true);
  });
});
