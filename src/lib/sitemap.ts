/** Parse a sitemap.xml (or sitemapindex) and return all URLs as strings. */

// Deliberately greedy+unambiguous: `[^<]*` has exactly one way to match a
// given span, so the engine can't backtrack. The previous pattern
// (`\s*([^<\s][^<]*?)\s*`) had a lazy inner quantifier immediately
// followed by another quantifier (`\s*`) that matches some of the same
// characters (whitespace) - a classic ReDoS shape. On adversarial input
// with a `<loc>` opener, a run of spaces, and no `</loc>` closer, the
// engine tries every way to split the run between the two quantifiers
// before giving up, which is quadratic in the run length: empirically
// confirmed 80KB of such input took ~5.2s (and scales ~4x per doubling),
// extrapolating to hours for a multi-MB adversarial sitemap response.
// `m[1]!.trim()` (below) already strips the leading/trailing whitespace
// the old regex's `\s*` was trying to do inline, so this is a pure
// ReDoS fix with no behavior change - confirmed via a 5000-case fuzz
// comparison against the old regex (0 mismatches) plus the 8KB+
// adversarial timing test (80KB: 5.2s -> 0ms; 10MB: ~14ms).
const LOC_RE = /<loc>([^<]*)<\/loc>/gi;

export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LOC_RE.exec(xml)) !== null) {
    const loc = m[1]!.trim();
    if (loc) urls.push(decodeXmlEntities(loc));
  }
  return urls;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Percent-decode and normalize a URL pathname so a `hasPathPrefix()`
 * authorization check can't be bypassed by encoded traversal segments -
 * or, subtler and more dangerous, by segments that *look* harmless to a
 * hand-rolled normalizer but that a `URL` object's own pathname parser
 * resolves completely differently once the value is actually assigned
 * back to a URL (which is exactly what `resolveRef()` and
 * `fetchSameOrigin()` do with this function's return value, to build the
 * URL that's actually fetched).
 *
 * This used to decode with `decodeURIComponent()` and normalize with
 * Node's `path.posix.normalize()`. That mismatched the *real* consumer
 * (a WHATWG `URL`) in two empirically-confirmed ways, both of which are
 * full authorization-boundary bypasses (the check passes, but the
 * pathname that's actually fetched afterward is different and outside
 * `docsPrefix`):
 *
 *  1. Backslash: for "special" schemes (http/https - all this project
 *     ever deals with), the `URL` path parser treats a literal "\" the
 *     same as "/" when *parsing/assigning* a pathname, but POSIX path
 *     semantics don't. `decodeURIComponent('%5c..%5c..%5capi')` produces
 *     the literal string `\..\..\api`; `path.posix.normalize()` sees
 *     that (no "/" in it) as one ordinary segment and leaves it alone -
 *     so it passed `hasPathPrefix(..., '/docs')`. But
 *     `url.pathname = '/docs/\\..\\..\\api/private'` immediately
 *     collapses to "/api/private" once the `URL` setter re-parses it.
 *  2. Double percent-encoding: `decodeURIComponent()` only unwraps one
 *     encoding layer, so "%252e%252e" (which is "%2e%2e" with its "%"
 *     itself encoded) decodes to the literal string "%2e%2e" -
 *     `path.posix.normalize()` doesn't recognize that as a dot-segment
 *     (it's not literally "." or ".."), so it also passed the check. But
 *     the WHATWG URL spec *does* special-case a literal "%2e%2e" segment
 *     as equivalent to ".." when *parsing* a path (precisely to close
 *     this exact percent-encoding bypass for URL consumers in general)
 *     - so assigning it to `.pathname` again collapses straight through
 *     to outside `docsPrefix`, the same as case 1.
 *
 * Both were fully reproduced end-to-end against this file's *previous*
 * implementation: "https://host/docs/%5c..%5c..%5capi/private" and
 * "https://host/docs/%252e%252e/admin/secrets" each passed the prefix
 * check yet resolved (after the exact `url.pathname = normalized`
 * assignment `resolveRef()` performs) to "/api/private" and
 * "/admin/secrets" respectively - both outside "/docs".
 *
 * The fix: stop trying to reimplement what a `URL` object will do with a
 * pathname, and instead *ask* one. Decoding once with
 * `decodeURIComponent()` and assigning the result to a scratch `URL`'s
 * `.pathname` produces exactly the pathname a real fetch would use
 * (including the WHATWG spec's own backslash- and
 * percent-encoded-dot-segment handling), so checking `hasPathPrefix()`
 * against *that* can no longer disagree with what actually gets fetched.
 * One behavioral side effect (not a security concern): characters like
 * space or non-ASCII that `decodeURIComponent()` would leave literal are
 * re-percent-encoded by the `URL` setter, so the returned pathname is a
 * canonical *encoded* form rather than a decoded one - callers that need
 * a human-readable path should decode this return value themselves.
 *
 * Returns `null` (rather than throwing) if the pathname contains
 * malformed percent-encoding (`decodeURIComponent` throws) or - belt and
 * suspenders, shouldn't be reachable given the scratch URL always has a
 * valid base - if the result doesn't start with "/", so callers can fail
 * closed with their own error type/message.
 */
export function decodeAndNormalizePathname(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const scratch = new URL('http://placeholder.invalid');
  try {
    scratch.pathname = decoded;
  } catch {
    return null;
  }
  const normalized = scratch.pathname;
  if (normalized !== '/' && !normalized.startsWith('/')) return null;
  return normalized;
}

/**
 * Returns true if `pathname` is exactly `prefix`, or a descendant of it
 * (`prefix` followed by "/"). Plain `startsWith` is not enough: "/docs2"
 * and "/docs-archive/x" both start with "/docs" but are not under it.
 *
 * `prefix` is normalized by stripping any trailing slash(es) first, so a
 * caller-supplied prefix like "/docs/" (e.g. via the `list_pages` tool's
 * `prefix` argument, which isn't run through the CLI's own normalization)
 * still matches descendants instead of matching nothing.
 */
export function hasPathPrefix(pathname: string, prefix: string): boolean {
  const p = prefix.replace(/\/+$/, '');
  if (p === '') return true;
  return pathname === p || pathname.startsWith(`${p}/`);
}

/**
 * True if `xml` is a sitemap *index* document (per the sitemaps.org
 * protocol, its `<loc>` entries point to OTHER sitemaps, not pages) rather
 * than a page-level `<urlset>` sitemap.
 */
export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Filter URLs to those under a given path prefix on the same host as
 * baseUrl.
 *
 * Uses `decodeAndNormalizePathname()` (not the raw `.pathname`) for the
 * prefix check, for the same reason `RemoteFumadocsSource.resolveRef()`
 * does: a sitemap entry like
 * "https://example.com/docs/%2e%2e%2fadmin/secrets" has a raw pathname
 * of "/docs/%2e%2e%2fadmin/secrets" (starts with "/docs/", so the naive
 * check would let it through) but decodes+normalizes to
 * "/admin/secrets" (outside docsPrefix). Without this, `list_pages`
 * would leak the existence of out-of-scope paths from a
 * malicious/compromised sitemap - a narrower issue than being able to
 * *fetch* such a path (which `resolveRef()` already independently
 * blocks), but still an authorization-boundary leak via the listing
 * itself. A pathname that fails to decode (malformed percent-encoding)
 * is dropped rather than listed, matching `resolveRef()`'s fail-closed
 * behavior.
 */
export function filterToDocs(
  urls: string[],
  baseUrl: string,
  docsPrefix: string,
): { url: string; path: string }[] {
  const base = new URL(baseUrl);
  const out: { url: string; path: string }[] = [];
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    if (parsed.host !== base.host) continue;
    const normalizedPath = decodeAndNormalizePathname(parsed.pathname);
    if (normalizedPath === null) continue;
    if (!hasPathPrefix(normalizedPath, docsPrefix)) continue;
    out.push({ url: u, path: normalizedPath });
  }
  return out;
}
