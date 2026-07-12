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

  it('rejects a double-encoded slash ("%252f") hiding a real separator', () => {
    // decodeURIComponent unwraps exactly one layer: '%252f' -> the literal
    // three-character text '%2f', which the WHATWG URL pathname parser
    // deliberately leaves alone (it never decodes "%2f" into a real "/"
    // while parsing, so it can't be confused about segment count). That
    // makes "/docs/..%252fprivate" normalize to "/docs/..%2fprivate" - one
    // harmless-looking segment to *us*, passing hasPathPrefix - but many
    // real HTTP servers *do* decode "%2f" while resolving the request
    // path, at which point "..%2fprivate" becomes the real segment "..",
    // escaping docsPrefix even though we already fetched that exact
    // literal pathname. Must fail closed instead.
    expect(decodeAndNormalizePathname('/docs/..%252fprivate')).toBeNull();
  });

  it('rejects a double-encoded backslash ("%255c") hiding a real separator', () => {
    expect(decodeAndNormalizePathname('/docs/..%255c..%255cadmin')).toBeNull();
  });

  it('rejects a *triple*-encoded slash ("%25252f"), not just double', () => {
    // Regression: this function used to decode only once, documenting
    // triple-encoding as an "accepted residual" on the theory that
    // exploiting it would require a real server to apply two *extra*
    // decode passes beyond the one already unwrapped here - much less
    // likely than the single extra pass the double-encoded case defends
    // against, but not impossible. A follow-up audit reproduced exactly
    // that against a simulated double-decoding upstream, so decoding now
    // continues to a fixed point (checking every intermediate pass, not
    // just the first) instead of stopping after one - closing the class
    // at any depth. "%25252f" -> (pass 1) "%252f" (still safe-looking) ->
    // (pass 2) the literal text "%2f" (caught).
    expect(decodeAndNormalizePathname('/docs/..%25252fprivate')).toBeNull();
  });

  it('rejects arbitrarily deeper encoding of a slash/backslash (quadruple+)', () => {
    // Generalizes beyond N=3: however many "%25" wrappers are stacked on
    // top, unwrapping them one at a time always passes through the
    // literal "%2f"/"%5c" text at exactly one intermediate pass.
    expect(decodeAndNormalizePathname('/docs/..%2525252fprivate')).toBeNull();
    expect(decodeAndNormalizePathname('/docs/..%252525252fprivate')).toBeNull();
    expect(decodeAndNormalizePathname('/docs/..%25252525255cadmin')).toBeNull();
  });

  it('fails closed when a separator is wrapped deeper than MAX_DECODE_PASSES can unwind', () => {
    // A 10-times-encoded slash only exposes the literal "%2f" text on its
    // 9th decode pass, one past the MAX_DECODE_PASSES=8 budget - so the
    // loop exhausts without ever reaching a fixed point *or* seeing the
    // %2f/%5c text, and must fail closed (return null) rather than fall
    // through and use a value that, for all we know, is still encoded.
    // ('%25'.repeat(k-1) + '2f' is a slash encoded k times; verified by
    // tracing decodeURIComponent pass-by-pass: the literal "%2f" text
    // only appears at pass index (k-2), so k=10 -> pass 8, outside the
    // i<8 loop bound.)
    const tenTimesEncodedSlash = '%' + '25'.repeat(9) + '2f';
    expect(decodeAndNormalizePathname('/docs/..' + tenTimesEncodedSlash + 'private')).toBeNull();
  });

  it('does not false-positive on ordinary encoded characters (space, unicode, literal %)', () => {
    expect(decodeAndNormalizePathname('/docs/my%20page')).toBe('/docs/my%20page');
    expect(decodeAndNormalizePathname('/docs/caf%C3%A9')).toBe('/docs/caf%C3%A9');
    expect(decodeAndNormalizePathname('/docs/50%25-off-sale')).toBe('/docs/50%-off-sale');
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

  it('drops a sitemap entry hiding a double-encoded separator', () => {
    const urls = ['https://example.com/docs/..%252fprivate', 'https://example.com/docs/legit'];
    const filtered = filterToDocs(urls, 'https://example.com/', '/docs');
    expect(filtered.map((f) => f.path)).toEqual(['/docs/legit']);
  });

  it('excludes a same-host entry on a different scheme (origin, not just host, must match)', () => {
    // Regression: filterToDocs() used to compare `.host` (hostname+port)
    // only, so "http://example.com/docs/x" was treated as in-scope for a
    // "https://example.com/" base even though they're different origins -
    // inconsistent with RemoteFumadocsSource.resolveRef()/
    // fetchSameOrigin(), which both compare `.origin` specifically because
    // scheme matters (see their doc comments).
    const urls = ['http://example.com/docs/x', 'https://example.com/docs/y'];
    const filtered = filterToDocs(urls, 'https://example.com/', '/docs');
    expect(filtered.map((f) => f.path)).toEqual(['/docs/y']);
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
