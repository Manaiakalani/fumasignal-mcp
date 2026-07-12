import { describe, expect, it } from 'vitest';
import { errSerializer, redactUrlForLogging } from '../src/lib/logger.js';

describe('errSerializer', () => {
  it('truncates an Error whose message is huge, instead of writing it in full to the log line', () => {
    // Regression: errorResult() in server.ts logs a tool's error message
    // via `logger.warn({ err: message }, ...)` *before*
    // capToolResultChars() ever truncates it for the returned response -
    // and the message can be attacker/site-controlled and unbounded (e.g.
    // a remote docs site's fetch/parse error). Empirically, a single
    // ~500,000-character log line measured minutes of wall-clock time to
    // fully write out in one CI environment (pino's stderr destination
    // defaults to a synchronous write), even though the surrounding test
    // logic itself took only seconds - so this is a real, demonstrated
    // resource-exhaustion vector, not just a hypothetical one.
    const huge = new Error('z'.repeat(500_000));
    const serialized = errSerializer(huge) as { type: string; message: string; stack?: string };
    expect(serialized.type).toBe('Error');
    expect(serialized.message.length).toBeLessThan(2_100);
    expect(serialized.message).toContain('truncated for log');
  });

  it('truncates a huge stack trace the same way as the message', () => {
    const err = new Error('boom');
    err.stack = `Error: boom\n${'    at fakeFrame\n'.repeat(50_000)}`;
    const serialized = errSerializer(err) as { stack?: string };
    expect(serialized.stack).toBeDefined();
    expect(serialized.stack!.length).toBeLessThan(2_100);
  });

  it('truncates a huge plain string logged directly under the `err` key', () => {
    // errorResult() passes a plain string (not an Error instance) under
    // `err` - pino's own default serializer only special-cases
    // `instanceof Error` and otherwise passes non-Error values through
    // completely unchanged, so this path needs its own truncation.
    const serialized = errSerializer('Source error: ' + 'z'.repeat(500_000));
    expect(typeof serialized).toBe('string');
    expect((serialized as string).length).toBeLessThan(2_100);
  });

  it('leaves an ordinary, reasonably sized Error unchanged in shape and content', () => {
    const err = new Error('not found');
    const serialized = errSerializer(err) as { type: string; message: string; stack?: string };
    expect(serialized.type).toBe('Error');
    expect(serialized.message).toBe('not found');
    expect(serialized.stack).toContain('not found');
  });

  it('leaves an ordinary, reasonably sized plain string unchanged', () => {
    expect(errSerializer('a short error string')).toBe('a short error string');
  });

  it('passes through a non-Error, non-string value unchanged (defensive fallback)', () => {
    const value = { custom: 'shape' };
    expect(errSerializer(value)).toBe(value);
  });
});

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

  it('masks the full userinfo in a protocol-relative URL whose password itself contains "@", not just up to the first "@"', () => {
    // Regression: the fallback regex used to exclude "@" from its captured
    // span, so it only ever matched up to the *first* "@" - but WHATWG
    // URL parsing treats the *last* "@" before the next "/", "?", or "#"
    // as the userinfo delimiter (a password may itself contain "@"). For
    // "//alice:very@secret@example.com/docs" that mismatch used to mask
    // only "//alice:very@", leaving "secret@example.com/docs" - including
    // part of the real password - unredacted in the log line.
    const redacted = redactUrlForLogging('//alice:very@secret@example.com/docs');
    expect(redacted).toBe('//***@example.com/docs');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('alice');
  });

  it('still masks userinfo in a protocol-relative URL preceded by leading whitespace', () => {
    // Regression: the fallback regex was anchored with "^\/\/", so any
    // leading whitespace before the "//" (operator-typed config values
    // aren't guaranteed to be pre-trimmed) made the whole pattern fail to
    // match - falling through to "return unchanged" and leaking the
    // credential completely, rather than just imperfectly.
    const redacted = redactUrlForLogging('  //alice:s3cret@evil.example/x');
    expect(redacted).toBe('  //***@evil.example/x');
    expect(redacted).not.toContain('s3cret');
  });

  it('returns an empty string unchanged, without throwing', () => {
    expect(() => redactUrlForLogging('')).not.toThrow();
    expect(redactUrlForLogging('')).toBe('');
  });

  it('truncates a very long parseable URL that has no userinfo, instead of logging it in full', () => {
    // Regression: redactUrlForLogging()'s "no userinfo" return path
    // (`return truncateForLog(url)`, added alongside the other two return
    // paths below) used to return the URL verbatim with no length bound -
    // a sitemap <loc> entry (or any operator/site-supplied URL) is
    // bounded only by the overall response-size cap, not any per-URL
    // limit, reproducing the same huge-log-line cost errSerializer() is
    // regression-tested against above.
    const url = `https://example.com/${'x'.repeat(500_000)}`;
    const redacted = redactUrlForLogging(url);
    expect(redacted.length).toBeLessThan(2_100);
    expect(redacted).toContain('truncated for log');
  });

  it('truncates a very long parseable URL that DOES have userinfo, instead of logging it in full', () => {
    const url = `https://alice:s3cret@example.com/${'x'.repeat(500_000)}`;
    const redacted = redactUrlForLogging(url);
    expect(redacted.length).toBeLessThan(2_100);
    expect(redacted).toContain('truncated for log');
    expect(redacted).not.toContain('s3cret');
  });

  it('truncates a very long value that is not parseable as a URL at all (fallback path), instead of logging it in full', () => {
    // Exercises the third (unparseable) return path's own truncateForLog()
    // wrap - a bare path with no scheme and no "//user:pass@" shape at
    // all, so the fallback regex is a no-op and the original untruncated
    // string would otherwise flow straight through unchanged.
    const bare = '/'.repeat(500_000);
    const redacted = redactUrlForLogging(bare);
    expect(redacted.length).toBeLessThan(2_100);
    expect(redacted).toContain('truncated for log');
  });
});
