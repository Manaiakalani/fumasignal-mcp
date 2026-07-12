import pino from 'pino';

/**
 * Cap on how many characters of a logged value are ever written to a log
 * line - an error's `message`/`stack` (or a plain string logged under the
 * `err` key), or a URL passed through `redactUrlForLogging()`. Generous
 * for any real diagnostic need, but bounds a class of issue empirically
 * confirmed while auditing this file: several call sites log a value
 * built from content that can be attacker/site-influenced and unbounded
 * in length - e.g. `errorResult()` in server.ts logs a tool's full error
 * message before `capToolResultChars()` ever truncates it for the
 * *response*, a remote docs site controls what ends up in a fetch/parse
 * error's `.message`, and a sitemap `<loc>` entry (also only bounded by
 * the overall response-size cap, not any per-URL limit) is logged via
 * `redactUrlForLogging()` on failure. A single multi-hundred-KB log line
 * was measured to make a CI job's synchronous stderr write (pino's
 * well-known-fd destinations default to sync mode) take *minutes* in one
 * environment even though the actual test logic finished in seconds - log
 * destinations are not guaranteed to drain quickly, and there is no
 * reason a diagnostic log line needs the *entire* value when the cap on
 * the returned tool result already makes anything past a few hundred
 * characters redundant for debugging purposes.
 */
const MAX_LOGGED_FIELD_CHARS = 2_000;

function truncateForLog(s: string): string {
  return s.length > MAX_LOGGED_FIELD_CHARS
    ? `${s.slice(0, MAX_LOGGED_FIELD_CHARS)}\u2026[truncated for log]`
    : s;
}

/**
 * Replaces pino's default `err` serializer (which reproduces `type`,
 * `message`, and `stack` verbatim with no length limit) with one that
 * caps `message`/`stack` via `truncateForLog()`. Applies the same cap to
 * a plain string logged under `err` (as `errorResult()` does), since
 * pino only serializes values that are `instanceof Error` by default and
 * otherwise passes the value through completely unchanged.
 *
 * Exported (rather than kept as a `pino()`-config-local closure) purely
 * so tests can exercise the truncation logic directly, without needing
 * to intercept pino's actual destination stream.
 */
export function errSerializer(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      type: err.name,
      message: truncateForLog(err.message),
      ...(err.stack ? { stack: truncateForLog(err.stack) } : {}),
    };
  }
  return typeof err === 'string' ? truncateForLog(err) : err;
}

// CRITICAL: STDIO transport uses stdout for JSON-RPC. ALL logging must go to stderr.
export const logger = pino(
  {
    level: process.env.FUMASIGNAL_LOG_LEVEL ?? 'info',
    base: undefined,
    serializers: { err: errSerializer },
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
    // than risk mangling it. But two other shapes ALSO land here and can
    // carry real userinfo: (1) a *protocol-relative* URL
    // ("//user:pass@host/...") - the parser requires a base to resolve a
    // leading "//" with no scheme; and (2) a URL that DOES have a scheme
    // but that the parser otherwise rejects as malformed - e.g. an
    // invalid port, an empty/missing host, or an unterminated IPv6
    // bracket (empirically confirmed: "https://user:pass@[::1" throws
    // "Invalid URL" despite unambiguously carrying userinfo). Operator
    // config values aren't guaranteed to be well-formed, and a malformed
    // URL is exactly the kind of value likely to end up echoed into an
    // error message or log line. Mask both shapes via a targeted pattern
    // match on the original string rather than resolving against a
    // synthetic base, which would fabricate a scheme that was never
    // actually present and risk producing a misleading logged value.
    //
    // Three things the pattern has to get right that a naive "up to the
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
    // (3) an optional `scheme:` immediately before the "//" - covering
    // shape (2) above - is captured as part of the same leading-marker
    // group so it's preserved unchanged in the output rather than eaten.
    //
    // Wrapped in truncateForLog(): this fallback runs on values the
    // WHATWG parser couldn't parse at all, which imposes no length limit
    // of its own (e.g. sitemap `<loc>` entries are bounded only by the
    // overall response-size cap, not any per-URL limit - see
    // MAX_LOGGED_FIELD_CHARS' doc comment).
    return truncateForLog(
      url.replace(/^(\s*(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)([^/?#]*)@/, '$1***@'),
    );
  }
  if (!parsed.username && !parsed.password) return truncateForLog(url);
  parsed.username = '***';
  parsed.password = '';
  return truncateForLog(parsed.toString());
}
