import TurndownService from 'turndown';

let cached: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (cached) return cached;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.remove(['script', 'style', 'noscript', 'iframe']);
  cached = td;
  return td;
}

const ARTICLE_TAGS = ['article', 'main'];
const STRIP_TAGS = ['nav', 'aside', 'header', 'footer', 'script', 'style', 'noscript'];

/**
 * Best-effort extraction of the main article HTML from a Fumadocs (or any)
 * documentation page. We pick the largest <article> or <main>, then strip
 * navigation / sidebar chrome, then convert to Markdown.
 */
export function htmlToMarkdown(html: string): string {
  const article = pickArticle(html);
  const stripped = stripChrome(article);
  return getTurndown().turndown(stripped).trim();
}

/**
 * Exported (in addition to being used internally) so it can be unit tested
 * directly, including with adversarial/large inputs that would otherwise
 * need to survive a full turndown/domino HTML-parse pass to be observed.
 */
export function pickArticle(html: string): string {
  for (const tag of ARTICLE_TAGS) {
    const best = findLargestTagBlock(html, tag);
    if (best !== null) return best;
  }
  return html;
}

/** All start indices of `</tag>` in `html`, in ascending order. */
function findCloserPositions(html: string, tag: string): number[] {
  const re = new RegExp(`<\\/${tag}>`, 'gi');
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m.index);
  return out;
}

/**
 * Find the largest `<tag ...>...</tag>` block's inner content.
 *
 * This intentionally avoids the classic `<tag\b[^>]*>([\s\S]*?)<\/tag>`
 * pattern executed in a `while (re.exec(...))` loop: with a lazy
 * dot-all group and no matching closer, each failed match attempt scans
 * all the way to the end of the string, and the engine retries at every
 * subsequent start position - O(n) work repeated at O(n) positions is
 * O(n^2) overall. Empirically confirmed: ~2.4s to process 720KB of
 * adversarial input (many openers, no closer), scaling quadratically.
 *
 * Instead, we collect all closer positions once (one linear scan), then
 * walk openers once, advancing a closer pointer that only ever moves
 * forward. Total work is O(n) regardless of how many openers/closers
 * exist or whether a closer exists at all.
 */
function findLargestTagBlock(html: string, tag: string): string | null {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closers = findCloserPositions(html, tag);
  let closerPtr = 0;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const contentStart = m.index + m[0].length;
    while (closerPtr < closers.length && closers[closerPtr]! < contentStart) closerPtr++;
    if (closerPtr >= closers.length) break; // no more closers available for any further opener
    const inner = html.slice(contentStart, closers[closerPtr]!);
    if (best === null || inner.length > best.length) best = inner;
  }
  return best;
}

/** Exported for direct unit testing - see {@link pickArticle}. */
export function stripChrome(html: string): string {
  let out = html;
  for (const tag of STRIP_TAGS) {
    out = removeTagBlocks(out, tag);
  }
  return out;
}

/**
 * Remove every non-overlapping `<tag ...>...</tag>` block from `html`.
 * Same O(n) approach as {@link findLargestTagBlock} - see that function's
 * comment for why this avoids the quadratic-blowup regex pattern.
 */
function removeTagBlocks(html: string, tag: string): string {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closers = findCloserPositions(html, tag);
  const closeLen = `</${tag}>`.length;
  let closerPtr = 0;
  let result = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    while (closerPtr < closers.length && closers[closerPtr]! < m.index + m[0].length) closerPtr++;
    if (closerPtr >= closers.length) break; // unclosed; leave the remainder untouched
    const closeStart = closers[closerPtr]!;
    const closeEnd = closeStart + closeLen;
    result += html.slice(cursor, m.index);
    cursor = closeEnd;
    closerPtr++;
    openRe.lastIndex = closeEnd;
  }
  result += html.slice(cursor);
  return result;
}
