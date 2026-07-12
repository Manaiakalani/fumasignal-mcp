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
 * All indices of the literal `>` character in `html`, in ascending
 * order. Uses `String.indexOf` (never backtracks) rather than a regex,
 * so repeated calls with an ever-advancing `fromIndex` are O(n) total -
 * see {@link findLargestTagBlock} for why that matters.
 */
function findAngleClosePositions(html: string): number[] {
  const out: number[] = [];
  let idx = html.indexOf('>');
  while (idx !== -1) {
    out.push(idx);
    idx = html.indexOf('>', idx + 1);
  }
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
 * The *opening*-tag search itself is a second, distinct instance of the
 * same class of bug: `<tag\b[^>]*>` still has an unbounded `[^>]*`
 * quantifier, so adversarial input with many `<tag` occurrences and no
 * `>` character reachable anywhere ahead makes every attempt scan to the
 * end of the remaining string before failing - O(n^2) again, even
 * though the *closing*-tag search was already fixed. Empirically
 * confirmed: ~5.5s for 200KB of "<nav" repeated with no ">" anywhere.
 *
 * Fixed the same way: collect all closer positions AND all literal `>`
 * positions once (two linear scans), find opener starts with a *bounded*
 * regex (`<tag\b`, no trailing quantifier - matching or failing at any
 * one position is O(tag.length), not O(remaining)), then walk openers
 * once, advancing both a "closing `>` of this opening tag" pointer and a
 * "closing `</tag>`" pointer that only ever move forward. Total work is
 * O(n) regardless of how many openers/closers exist or whether either
 * exists at all.
 */
function findLargestTagBlock(html: string, tag: string): string | null {
  // Cheap existence pre-check before the position-array scans below.
  // findAngleClosePositions() in particular collects *every* literal '>'
  // in `html` regardless of whether `tag` appears anywhere at all -
  // empirically ~200MB+ of heap for a 10MB adversarial input consisting
  // of nothing but '>' characters, run unconditionally on every call
  // (pickArticle() alone tries up to 2 tags, stripChrome() up to 6 more -
  // and a page with no semantic <article>/<main>/<nav>/etc. tags at all,
  // which is common on non-Fumadocs sites, hits every one of them). A
  // non-global one-off RegExp (no `g` flag) is used here so it can't
  // perturb `openRe`'s own `lastIndex` state in the loop below.
  if (!new RegExp(`<${tag}\\b`, 'i').test(html)) return null;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closers = findCloserPositions(html, tag);
  const angles = findAngleClosePositions(html);
  let closerPtr = 0;
  let anglePtr = 0;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    // Position of the literal '>' that ends *this* opening tag -
    // equivalent to what the old `[^>]*>` suffix would have matched.
    while (anglePtr < angles.length && angles[anglePtr]! < m.index + m[0].length) anglePtr++;
    if (anglePtr >= angles.length) break; // this (and every later) opening tag never closes
    const contentStart = angles[anglePtr]! + 1;
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
 * comment for why this avoids the quadratic-blowup regex pattern (both
 * for the closing-tag search and the opening-tag search).
 */
function removeTagBlocks(html: string, tag: string): string {
  // Same pre-check as findLargestTagBlock() above, for the same reason -
  // see its comment.
  if (!new RegExp(`<${tag}\\b`, 'i').test(html)) return html;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closers = findCloserPositions(html, tag);
  const angles = findAngleClosePositions(html);
  const closeLen = `</${tag}>`.length;
  let closerPtr = 0;
  let anglePtr = 0;
  let result = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    while (anglePtr < angles.length && angles[anglePtr]! < m.index + m[0].length) anglePtr++;
    if (anglePtr >= angles.length) break; // this (and every later) opening tag never closes; leave the remainder untouched
    const contentStart = angles[anglePtr]! + 1;
    while (closerPtr < closers.length && closers[closerPtr]! < contentStart) closerPtr++;
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
