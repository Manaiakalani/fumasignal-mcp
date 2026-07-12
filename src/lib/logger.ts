import pino from 'pino';

// CRITICAL: STDIO transport uses stdout for JSON-RPC. ALL logging must go to stderr.
export const logger = pino(
  {
    level: process.env.FUMASIGNAL_LOG_LEVEL ?? 'info',
    base: undefined,
  },
  pino.destination(2), // file descriptor 2 = stderr
);

/**
 * Return `url` with any embedded userinfo (`user:pass@host`) masked, for
 * safe inclusion in a log line. RFC 3986 permits credentials directly in a
 * URL's authority component, and this tool logs operator/site-supplied
 * URLs at several points (the configured `--url`/`FUMASIGNAL_URL` at
 * startup, sitemap `<loc>` entries, constructed same-origin candidate
 * URLs) - all bounded only by "did this call happen to receive a URL",
 * not by any check that it doesn't carry a credential. The intended way
 * to authenticate to a remote docs site is `--auth-header`, which is
 * deliberately excluded from every log call in this codebase - but
 * nothing stops an operator (or a misconfigured integration generating
 * the URL) from embedding credentials directly in the URL instead, and
 * unlike the auth header, a URL is exactly the kind of value that ends up
 * in a log line. Call this at every site that logs a URL so the guarantee
 * holds regardless of where the URL originated or how it was built.
 *
 * Only userinfo is redacted, not the query string: query parameters are
 * extremely common and overwhelmingly non-sensitive (locale filters, page
 * numbers, etc.), and this tool has no documented convention of passing
 * credentials via query string (unlike userinfo, which is a well-defined,
 * long-deprecated URL credential mechanism - RFC 3986 section 3.2.1 - that
 * this function targets specifically). Blanket-redacting every query string
 * would destroy log usefulness for a threat this codebase doesn't
 * otherwise treat as realistic.
 */
export function redactUrlForLogging(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable absolute URL (e.g. a bare path) - nothing to redact,
    // and safer to pass it through unchanged than to risk mangling it.
    return url;
  }
  if (!parsed.username && !parsed.password) return url;
  parsed.username = '***';
  parsed.password = '';
  return parsed.toString();
}
