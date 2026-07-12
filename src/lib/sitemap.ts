/** Parse a sitemap.xml (or sitemapindex) and return all URLs as strings. */

const LOC_RE = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;

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

/** Filter URLs to those under a given path prefix on the same host as baseUrl. */
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
    if (!hasPathPrefix(parsed.pathname, docsPrefix)) continue;
    out.push({ url: u, path: parsed.pathname });
  }
  return out;
}
