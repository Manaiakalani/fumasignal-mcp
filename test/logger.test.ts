import { describe, expect, it } from 'vitest';
import { redactUrlForLogging } from '../src/lib/logger.js';

describe('redactUrlForLogging', () => {
  it('masks a username+password pair embedded in a URL', () => {
    // Regression: cli.ts/remote.ts logged operator/site-supplied URLs
    // verbatim. A URL with RFC 3986 userinfo credentials
    // (https://user:pass@host/...) would leak the password directly into
    // logs otherwise.
    const redacted = redactUrlForLogging('https://alice:s3cret@example.com/docs/sitemap.xml');
    expect(redacted).not.toContain('s3cret');
    expect(redacted).not.toContain('alice');
    expect(redacted).toBe('https://***@example.com/docs/sitemap.xml');
  });

  it('masks a username-only (no password) URL', () => {
    const redacted = redactUrlForLogging('https://alice@example.com/docs');
    expect(redacted).not.toContain('alice');
    expect(redacted).toBe('https://***@example.com/docs');
  });

  it('preserves the path, query string, and hash unchanged when redacting', () => {
    // Only userinfo is in scope - see the doc comment on
    // redactUrlForLogging for why query/hash are deliberately untouched.
    const redacted = redactUrlForLogging('https://alice:s3cret@example.com/docs/page?locale=en#section');
    expect(redacted).toBe('https://***@example.com/docs/page?locale=en#section');
  });

  it('returns a URL without any userinfo completely unchanged', () => {
    const url = 'https://example.com/docs/sitemap.xml?x=1';
    expect(redactUrlForLogging(url)).toBe(url);
  });

  it('returns a non-parseable string (e.g. a bare path) unchanged, without throwing', () => {
    expect(() => redactUrlForLogging('/docs/getting-started')).not.toThrow();
    expect(redactUrlForLogging('/docs/getting-started')).toBe('/docs/getting-started');
  });

  it('masks userinfo in a protocol-relative URL ("//user:pass@host/...") that the WHATWG parser rejects outright', () => {
    // Regression: new URL() throws for a protocol-relative string (it has
    // no scheme and no base to resolve against), which used to fall
    // through to the "unparseable, return unchanged" branch - silently
    // leaking real credentials for exactly the kind of operator-typed,
    // not-yet-validated value (e.g. a --url passed before it's ever
    // parsed/validated elsewhere) that's missing a scheme by mistake.
    expect(redactUrlForLogging('//alice:s3cret@example.com/docs')).toBe('//***@example.com/docs');
    expect(redactUrlForLogging('//alice:s3cret@example.com/docs')).not.toContain('s3cret');
  });

  it('masks userinfo in a protocol-relative URL with a username but no password', () => {
    expect(redactUrlForLogging('//alice@example.com/docs')).toBe('//***@example.com/docs');
  });

  it('does not mistake an "@" inside a protocol-relative URL\'s path for userinfo', () => {
    // No credentials here at all - just a path segment that happens to
    // contain "@" (e.g. a retina-image-style filename). Must be left
    // completely unchanged, not have a "//***@" prefix fabricated.
    const url = '//example.com/docs/photo@2x.png';
    expect(redactUrlForLogging(url)).toBe(url);
  });

  it('leaves an ordinary protocol-relative URL with no userinfo at all unchanged', () => {
    const url = '//example.com/docs/page';
    expect(redactUrlForLogging(url)).toBe(url);
  });

  it('returns an empty string unchanged, without throwing', () => {
    expect(() => redactUrlForLogging('')).not.toThrow();
    expect(redactUrlForLogging('')).toBe('');
  });
});
