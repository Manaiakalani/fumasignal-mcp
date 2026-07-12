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

/**
 * Wraps a "find the next match at or after `fromIndex`, or -1" probe
 * into a lazy, memoizing finder: `next(from)` returns the smallest
 * matched position that is `>= from`, computing it on demand instead of
 * upfront. This exists so {@link findLargestTagBlock}/
 * {@link removeTagBlocks} don't have to eagerly collect *every* closer/
 * `>` position in the whole document before even knowing whether the
 * document contains more than a couple of the tag being searched for.
 *
 * Correctness/complexity depend on callers only ever querying with a
 * non-decreasing sequence of `from` values across the *whole* matching
 * loop (true for both call sites below: each is driven by a global
 * regex whose match positions strictly advance, and by a content-start
 * position derived from another already-monotonic finder) - the single
 * cached position then only ever advances forward, and each underlying
 * `probe()` call does work proportional to how far it advances, so the
 * total work across every call this finder ever receives is O(n),
 * exactly matching an eager array-based two-pointer approach, just
 * computed lazily instead of upfront. `probe` itself must be a
 * *bounded* per-position test (no unbounded quantifier - see this
 * file's other comments on why that matters), not merely "doesn't
 * backtrack".
 */
function lazyPositionFinder(probe: (fromIndex: number) => number): (from: number) => number {
  let cached: number | null = null; // null = never probed yet
  return (from: number): number => {
    if (cached === null) cached = probe(0);
    while (cached !== -1 && cached < from) cached = probe(cached + 1);
    return cached;
  };
}

/**
 * Lazy finder for the literal `>` character. Uses `String.indexOf`
 * (never backtracks) rather than a regex - not that it would matter for
 * a single unquantified character, but it keeps this symmetric with the
 * historical implementation's own reasoning for preferring it.
 */
function lazyAngleFinder(html: string): (from: number) => number {
  return lazyPositionFinder((fromIndex) => html.indexOf('>', fromIndex));
}

/** Lazy finder for `</tag>` (case-insensitive). */
function lazyCloserFinder(html: string, tag: string): (from: number) => number {
  const re = new RegExp(`<\\/${tag}>`, 'gi');
  return lazyPositionFinder((fromIndex) => {
    re.lastIndex = fromIndex;
    const m = re.exec(html);
    return m ? m.index : -1;
  });
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
 * Fixed the same way: find opener starts with a *bounded* regex
 * (`<tag\b`, no trailing quantifier - matching or failing at any one
 * position is O(tag.length), not O(remaining)), then walk openers once,
 * advancing both a "closing `>` of this opening tag" finder and a
 * "closing `</tag>`" finder that only ever move forward - see
 * {@link lazyPositionFinder}. Total work is O(n) regardless of how many
 * openers/closers exist or whether either exists at all, AND without
 * ever eagerly materializing a position array sized by how many `>`/
 * closer occurrences exist elsewhere in the document, unrelated to
 * `tag` - see the pre-check comment just below for why that distinction
 * matters even with the O(n) bound already in place.
 */
function findLargestTagBlock(html: string, tag: string): string | null {
  // Cheap existence pre-check before doing any real work below. This
  // guards a *different, narrower* case than the lazy finders do: a
  // document that never contains `tag` at all short-circuits in
  // O(html.length) via this one bounded regex test, without even
  // constructing the closer/angle finders. Tags that DO appear (even
  // just once, amid megabytes of unrelated content) are now handled
  // efficiently by the finders' own laziness instead of needing a
  // separate guard - they only ever scan as far as the actual matches
  // require, never the whole remaining document regardless of `tag`'s
  // presence. A non-global one-off RegExp (no `g` flag) is used here so
  // it can't perturb `openRe`'s own `lastIndex` state in the loop below.
  if (!new RegExp(`<${tag}\\b`, 'i').test(html)) return null;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const nextCloser = lazyCloserFinder(html, tag);
  const nextAngle = lazyAngleFinder(html);
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    // Position of the literal '>' that ends *this* opening tag -
    // equivalent to what the old `[^>]*>` suffix would have matched.
    const angle = nextAngle(m.index + m[0].length);
    if (angle === -1) break; // this (and every later) opening tag never closes
    const contentStart = angle + 1;
    const closeStart = nextCloser(contentStart);
    if (closeStart === -1) break; // no more closers available for any further opener
    const inner = html.slice(contentStart, closeStart);
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
 * for the closing-tag search and the opening-tag search), and for why
 * lazily-computed finders (rather than eager position arrays) matter
 * even with the O(n) bound already in place.
 */
function removeTagBlocks(html: string, tag: string): string {
  // Same pre-check as findLargestTagBlock() above, for the same reason -
  // see its comment.
  if (!new RegExp(`<${tag}\\b`, 'i').test(html)) return html;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const nextCloser = lazyCloserFinder(html, tag);
  const nextAngle = lazyAngleFinder(html);
  const closeLen = `</${tag}>`.length;
  let result = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const angle = nextAngle(m.index + m[0].length);
    if (angle === -1) break; // this (and every later) opening tag never closes; leave the remainder untouched
    const contentStart = angle + 1;
    const closeStart = nextCloser(contentStart);
    if (closeStart === -1) break; // unclosed; leave the remainder untouched
    const closeEnd = closeStart + closeLen;
    result += html.slice(cursor, m.index);
    cursor = closeEnd;
    openRe.lastIndex = closeEnd;
  }
  result += html.slice(cursor);
  return result;
}
