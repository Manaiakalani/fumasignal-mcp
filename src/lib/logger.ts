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
    // Not parseable as a standalone absolute URL by the WHATWG parser.
    // Most commonly this is just a bare path (e.g. "/docs/foo"), which
    // structurally can't carry userinfo - safe to return unchanged rather
    // than risk mangling it. But a *protocol-relative* URL
    // ("//user:pass@host/...") is ALSO rejected here (the parser requires
    // a base to resolve a leading "//" with no scheme), and unlike a bare
    // path, that shape can carry real userinfo - operator-typed config
    // values in particular aren't guaranteed to include a scheme. Mask it
    // via a targeted pattern match on the original string rather than
    // resolving against a synthetic base, which would fabricate a scheme
    // that was never actually present and risk producing a misleading
    // logged value.
    //
    // Two things the pattern has to get right that a naive "up to the
    // first @" match doesn't: (1) WHATWG userinfo parsing treats the
    // *last* "@" before the next "/", "?", or "#" as the delimiter, not
    // the first - a password can itself contain "@" (e.g.
    // "//alice:very@secret@host/x" has password "very@secret", not
    // username "alice", password "very", followed by a bare "secret@host"
    // authority) - so excluding "@" from the captured span, as a
    // first-match-wins character class would, leaks whatever comes after
    // the first "@" verbatim. Allowing "@" *into* the captured span and
    // relying on the regex engine's standard greedy-then-backtrack
    // behavior reproduces that "last @ wins" semantics for free: `*` first
    // consumes as much as possible, then backtracks one character at a
    // time until the character immediately after the captured span is
    // "@", which is necessarily the *last* "@" in the run. (2) a leading
    // "//" isn't guaranteed to be the very first character - operator
    // config values aren't guaranteed to be trimmed - so anchoring only at
    // "^\/\/" would fail to match (and thus leave a value *completely*
    // unredacted) if there's leading whitespace before it. Capturing
    // optional leading whitespace alongside the "//" marker and preserving
    // it in the replacement handles that without weakening the match.
    return url.replace(/^(\s*\/\/)([^/?#]*)@/, '$1***@');
  }
  if (!parsed.username && !parsed.password) return url;
  parsed.username = '***';
  parsed.password = '';
  return parsed.toString();
}
