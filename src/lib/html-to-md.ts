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

/** One matched `<tag ...>...</tag>` block found by {@link eachTagBlock}. */
interface TagBlock {
  /** Index of the `<` that opens the block. */
  start: number;
  /** Index just past the opening tag's `>`. */
  contentStart: number;
  /** Index of the `<` that opens the matching closing tag. */
  closeStart: number;
  /** Index just past the matching closing tag's `>`. */
  end: number;
  /** Nesting depth of this block; 0 for an outermost one. */
  depth: number;
}

/**
 * Yield every `<tag ...>...</tag>` block in `html`, pairing each opening
 * tag with its *properly nested* closing tag.
 *
 * Both callers previously paired an opening tag with whatever `</tag>`
 * happened to come next, with no notion of depth. HTML5 permits nesting
 * for both tags this file cares about, and real documentation pages do it
 * (an `<article>` card list inside the page's own `<article>`, a `<nav>`
 * inside a `<nav>`), so that shortcut silently mis-parsed such pages in
 * two opposite but equally wrong ways:
 *
 *  - {@link findLargestTagBlock} on
 *    `<article>1<article>2</article>3</article>` treated the *outer*
 *    article as ending at the *inner* article's closer, so the extracted
 *    body stopped after "2" and everything after it ("3", i.e. the rest
 *    of the page) was dropped.
 *  - {@link removeTagBlocks} on `<nav><nav></nav> LEAKED </nav>` removed
 *    only up to the first closer, leaving " LEAKED </nav>" - the very
 *    navigation chrome the strip pass exists to remove - in the output.
 *
 * Pairing is done with an explicit stack of open tags: openers and
 * closers are walked in a single merged pass, each opener is pushed, and
 * each closer pops the innermost still-open tag. `depth` is reported so
 * `removeTagBlocks` can act on outermost blocks only (a nested block is
 * already inside the text its parent removes).
 *
 * The O(n) guarantee the previous implementation was carefully built for
 * (see {@link findLargestTagBlock}'s comment for the quadratic-blowup
 * history) is preserved: `openRe`/`closeRe` are *bounded* patterns with
 * no unbounded quantifier, each is driven by `exec()` over its own
 * monotonically advancing `lastIndex`, `nextAngle` only ever moves
 * forward (openers are consumed in increasing index order), and every
 * loop iteration consumes exactly one opener or one closer. Total work is
 * therefore proportional to the number of tag occurrences plus the
 * distance scanned for `>` - linear in `html.length` regardless of how
 * the tags nest, or whether they are closed at all.
 */
function* eachTagBlock(html: string, tag: string): Generator<TagBlock> {
  // Cheap existence pre-check before doing any real work below. This
  // guards a *different, narrower* case than the lazy `>` finder does: a
  // document that never contains `tag` at all short-circuits in
  // O(html.length) via this one bounded regex test, without even
  // constructing the finder or the two global regexes. A non-global
  // one-off RegExp (no `g` flag) is used so it can't perturb `openRe`'s
  // own `lastIndex` state below.
  // `\b` is *not* good enough for a tag-name boundary: it fires between a
  // word char and any non-word char, so `<nav\b` happily matches
  // `<nav-bar`. That mattered a great deal - `</nav-bar>` then fails to
  // match `closeRe`, so the opener it pushed is never popped, and every
  // later block of that tag is left with a phantom ancestor on the stack.
  // A single custom element named `nav-*`/`header-*`/`footer-*` was enough
  // to silently disable chrome-stripping for that tag across the whole
  // page. An HTML tag name ends at whitespace, `/`, or `>`, so require one
  // of those to follow. (This still rejects `<navs>`, as `\b` did.)
  const openSrc = `<${tag}(?=[\\s/>])`;
  if (!new RegExp(openSrc, 'i').test(html)) return;
  const openRe = new RegExp(openSrc, 'gi');
  // HTML5 permits whitespace between the tag name and `>` in an end tag,
  // so `</nav >` is a perfectly valid closer and must not be missed - an
  // unmatched closer leaves its opener stranded on the stack, with the
  // same consequences described above.
  const closeRe = new RegExp(`<\\/${tag}\\s*>`, 'gi');
  const nextAngle = lazyAngleFinder(html);
  const open: Array<{ start: number; contentStart: number }> = [];
  let opener = openRe.exec(html);
  let closer = closeRe.exec(html);
  while (closer !== null) {
    if (opener !== null && opener.index < closer.index) {
      // Position of the literal '>' that ends *this* opening tag -
      // equivalent to what an `[^>]*>` suffix would have matched.
      const angle = nextAngle(opener.index + opener[0].length);
      if (angle === -1) return; // this (and every later) opening tag never terminates
      open.push({ start: opener.index, contentStart: angle + 1 });
      opener = openRe.exec(html);
      continue;
    }
    const innermost = open[open.length - 1];
    if (innermost === undefined) {
      closer = closeRe.exec(html); // stray closer with nothing open - ignore it
      continue;
    }
    if (innermost.contentStart > closer.index) {
      // This "closer" sits inside the opening tag's own text (e.g.
      // `<article title="</article>">`), so it closes nothing.
      closer = closeRe.exec(html);
      continue;
    }
    open.pop();
    yield {
      start: innermost.start,
      contentStart: innermost.contentStart,
      closeStart: closer.index,
      // Closer length is read from the match, not from `</tag>`.length,
      // because `closeRe` now tolerates internal whitespace.
      end: closer.index + closer[0].length,
      depth: open.length,
    };
    closer = closeRe.exec(html);
  }
  // Anything still on `open` never got a closer; leave it unreported, so
  // callers treat it as "no block here" exactly as they did before.
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
 * Both are avoided by {@link eachTagBlock}, which pairs bounded opener/
 * closer patterns against a forward-only `>` finder - see its comment
 * for why the whole walk stays O(n), and for why it tracks nesting depth
 * rather than pairing each opener with the next closer it can find.
 */
function findLargestTagBlock(html: string, tag: string): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const block of eachTagBlock(html, tag)) {
    const length = block.closeStart - block.contentStart;
    // Strictly greater, so the *first* block wins a tie - matching the
    // previous implementation's behavior.
    if (length > bestLength) {
      bestLength = length;
      best = html.slice(block.contentStart, block.closeStart);
    }
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
 * Remove every outermost `<tag ...>...</tag>` block from `html`.
 *
 * Selection is by *span overlap*, not by reported nesting depth. Depth
 * looks like the natural filter, but it is only meaningful when every
 * opener eventually gets a closer: an opener that never closes is never
 * popped, so it inflates the depth of every block that follows it and
 * those blocks are then skipped entirely. Real pages hit that constantly
 * (a stray `<nav>`, a tag closed by an ancestor rather than its own
 * closer), and the failure is silent - chrome simply stops being removed
 * from that point on.
 *
 * Sorting by start and walking left-to-right, skipping anything that
 * begins inside a span already removed, keeps the "remove the outermost,
 * never double-count a nested one" guarantee without depending on the
 * stack ever being balanced. `k` is the number of paired blocks of this
 * tag, so the sort is negligible against the O(n) scan that produced it.
 * See {@link eachTagBlock} for the pairing rules and the O(n) argument.
 */
function removeTagBlocks(html: string, tag: string): string {
  const blocks = [...eachTagBlock(html, tag)].sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const block of blocks) {
    if (block.start < cursor) continue; // nested inside a span already removed
    result += html.slice(cursor, block.start);
    cursor = block.end;
  }
  result += html.slice(cursor);
  return result;
}
