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
 *
 * Deeply nested input skips Turndown entirely. Turndown parses to a DOM and
 * walks it recursively, so nesting depth becomes call-stack depth: ~3k nested
 * elements throw `RangeError: Maximum call stack size exceeded` (lower on
 * runtimes with a smaller stack), and getting there is not cheap - 20k levels
 * blocks for ~4s and 100k for ~113s, all of it synchronous, which stalls every
 * other request this process is serving. Neither the tag-block caps below nor
 * a `try/catch` help: the caps hand the untouched input straight to Turndown,
 * and catching the `RangeError` still pays the stall. The only fix is to
 * refuse the document before it is parsed.
 */
export function htmlToMarkdown(html: string): string {
  const article = pickArticle(html);
  const stripped = stripChrome(article);
  // Cheap O(n) pre-check, so the expensive parse is never reached with input
  // that would blow the stack or stall the loop.
  if (exceedsNestingDepth(stripped, MAX_DOCUMENT_NESTING_DEPTH)) {
    return htmlToText(stripped);
  }
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
 * Ceiling on how deep chrome tags may nest before the tag is abandoned.
 * Real documents nest `<nav>`/`<article>` single digits deep; this exists
 * solely so that adversarial input cannot make the opener stack grow with
 * the tag count. See {@link removeTagBlocks} for the measurements.
 */
const MAX_TAG_NESTING_DEPTH = 1_000;

/**
 * Ceiling on how many blocks may sit un-flushed in {@link removeTagBlocks}.
 * Reached only when a stranded opener keeps everything at depth > 0, since
 * anything else flushes as soon as the stack empties. Sized well above any
 * plausible real page while still bounding the array to a few MB.
 */
const MAX_BUFFERED_TAG_BLOCKS = 50_000;

/**
 * Ceiling on element nesting depth handed to Turndown. Real documentation
 * pages sit comfortably under 50; this leaves a wide margin while staying
 * far below the depth at which the recursive DOM walk becomes either slow
 * or fatal. See {@link htmlToMarkdown} for the measurements.
 */
const MAX_DOCUMENT_NESTING_DEPTH = 500;

/** Elements that never have children, so they must not push a level. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * HTML5's optional-end-tag rules, as "opening X implicitly closes any of
 * these still-open elements". Without this an ordinary table or list that
 * omits `</td>`/`</li>` - which is legal and common - would appear to nest
 * one level per row or item and trip the depth limit on a perfectly
 * innocent page.
 */
const IMPLIED_END_TAGS = new Map<string, Set<string>>([
  ['p', new Set(['p'])],
  ['li', new Set(['li'])],
  ['dt', new Set(['dt', 'dd'])],
  ['dd', new Set(['dt', 'dd'])],
  ['option', new Set(['option'])],
  ['optgroup', new Set(['option', 'optgroup'])],
  ['tr', new Set(['td', 'th', 'tr'])],
  ['td', new Set(['td', 'th'])],
  ['th', new Set(['td', 'th'])],
  ['thead', new Set(['td', 'th', 'tr'])],
  ['tbody', new Set(['td', 'th', 'tr', 'thead', 'tbody'])],
  ['tfoot', new Set(['td', 'th', 'tr', 'thead', 'tbody'])],
]);

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
 * history) is preserved: each of `openRe`/`closeRe` is driven by `exec()`
 * over its own monotonically advancing `lastIndex`, `nextAngle` only ever
 * moves forward (openers are consumed in increasing index order), and
 * every loop iteration consumes exactly one opener or one closer. Total
 * work is therefore proportional to the number of tag occurrences plus
 * the distance scanned for `>` - linear in `html.length` regardless of
 * how the tags nest, or whether they are closed at all.
 *
 * `closeRe`'s `\s*` is the one unbounded quantifier here, and it is safe
 * because it is bounded *in aggregate* rather than per-match: `</tag`
 * occurrences cannot overlap, so the whitespace runs any two matches can
 * backtrack over are disjoint, and their total length is bounded by
 * `html.length`. Do not add a quantifier that lacks that property.
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
      // Uniformly-deepening input never pops, so the stack grows with the
      // tag count rather than with anything the response cap bounds:
      // ~900k `<nav>` in 10MB held ~144MB. Real documents nest chrome tags
      // single digits deep, so a four-figure ceiling only ever fires on
      // input that is pathological by construction. Abandoning the tag
      // entirely (rather than truncating) keeps the "remove outermost"
      // guarantee honest - a partial stack would strip inner blocks whose
      // ancestors we have stopped tracking.
      if (open.length >= MAX_TAG_NESTING_DEPTH) return;
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
 * Selection is by *span overlap*, not by reported nesting depth alone.
 * Depth looks like the natural filter, but it is only meaningful when
 * every opener eventually gets a closer: an opener that never closes is
 * never popped, so it inflates the depth of every block that follows it
 * and those blocks are then skipped entirely. Real pages hit that
 * constantly (a stray `<nav>`, a tag closed by an ancestor rather than
 * its own closer), and the failure is silent - chrome simply stops being
 * removed from that point on.
 *
 * Blocks arrive innermost-first, so they are buffered until they can be
 * ordered, then emitted left-to-right skipping anything that begins
 * inside a span already removed. That keeps the "remove the outermost,
 * never double-count a nested one" guarantee without depending on the
 * stack ever being balanced.
 *
 * The buffer is flushed every time a `depth === 0` block arrives, which
 * is what bounds memory on sibling-heavy pages: with the stack empty, no
 * later block can turn out to be an ancestor of anything already
 * buffered, so the batch is final and can be written out. Without that
 * flush, a hostile page near the 10MB response cap (~870k sibling
 * blocks) retained the whole block array at once - ~88MB of peak heap,
 * multiplied by the concurrent-fetch limit. With it, ~10MB.
 *
 * This bounds the *sibling* case directly. Uniformly-nested input never
 * reaches `depth === 0` until its last block, so the flush alone does
 * nothing for it; that shape is bounded instead by
 * {@link MAX_TAG_NESTING_DEPTH} and {@link MAX_BUFFERED_TAG_BLOCKS},
 * which cap the opener stack and this buffer respectively and fall back
 * to returning the input untouched. Returning it untouched is safe only
 * because {@link htmlToMarkdown} re-checks nesting depth afterwards and
 * refuses to hand a pathological document to Turndown - on its own, this
 * bail-out just moved the blow-up downstream.
 *
 * Note this genuinely needs the buffer: a single "pending block" variant
 * is wrong, because one ancestor can supersede several already-emitted
 * siblings.
 *
 * See {@link eachTagBlock} for the pairing rules and the O(n) argument.
 */
function removeTagBlocks(html: string, tag: string): string {
  let result = '';
  let cursor = 0;
  const batch: TagBlock[] = [];
  const flush = (): void => {
    batch.sort((a, b) => a.start - b.start);
    for (const block of batch) {
      if (block.start < cursor) continue; // nested inside a span already removed
      result += html.slice(cursor, block.start);
      cursor = block.end;
    }
    batch.length = 0;
  };
  for (const block of eachTagBlock(html, tag)) {
    batch.push(block);
    // The depth cap bounds the opener stack but not this buffer: one
    // unclosed outer tag keeps every later block at depth > 0, so nothing
    // flushes and the batch grows with the tag count. Bail out to the
    // untouched input rather than flushing early - a partial flush would
    // emit blocks that a later ancestor was still entitled to supersede,
    // which is the exact bug the buffer exists to prevent.
    if (batch.length >= MAX_BUFFERED_TAG_BLOCKS) return html;
    if (block.depth === 0) flush();
  }
  flush(); // anything left is under a stranded opener that never closed
  return result + html.slice(cursor);
}

/** Tag-name characters, per the subset any real document uses. */
function isNameChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 45 || // -
    code === 95 || // _
    code === 58 // :
  );
}

/**
 * End of a raw-text element (`<script>`/`<style>`), whose contents are not
 * markup and must not be scanned as if they were. Returns the index just
 * past the closing tag, or -1 when it never closes.
 */
function rawTextElementEnd(html: string, name: string, from: number): number {
  let cursor = from;
  for (;;) {
    const lt = html.indexOf('</', cursor);
    if (lt === -1) return -1;
    let i = lt + 2;
    let matched = 0;
    while (matched < name.length && i < html.length) {
      const c = html.charCodeAt(i);
      const lower = c >= 65 && c <= 90 ? c + 32 : c;
      if (lower !== name.charCodeAt(matched)) break;
      i++;
      matched++;
    }
    if (matched === name.length) {
      const gt = html.indexOf('>', i);
      return gt === -1 ? -1 : gt + 1;
    }
    cursor = lt + 2;
  }
}

/**
 * Walk `html` once, calling `onText` with each run of character data and
 * tracking element nesting depth. Returns true if `limit` was ever
 * exceeded, stopping early when it is.
 *
 * Deliberately a hand-rolled scanner rather than a parse: it is O(n) in the
 * input with no backtracking, allocates only the open-element stack, and is
 * the thing that runs *before* we are willing to pay for a real parse.
 * Unknown elements count towards depth, because the HTML parser nests them
 * like any other - a limit that only knew about known tag names would miss
 * `<x-a><x-a>...` entirely.
 */
function scanElements(
  html: string,
  limit: number,
  onText?: (chunk: string) => void,
): boolean {
  const open: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      onText?.(html.slice(i));
      break;
    }
    if (lt > i) onText?.(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    // Doctype, CDATA and processing instructions: skip to the next '>'.
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const isClosing = html.charCodeAt(lt + 1) === 47; // '/'
    const nameStart = lt + (isClosing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    if (nameEnd === nameStart) {
      // A bare '<' that starts no tag is literal text.
      onText?.('<');
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', nameEnd);
    if (gt === -1) break; // unterminated tag: nothing further is markup
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const selfClosing = html.charCodeAt(gt - 1) === 47; // '/'
    i = gt + 1;

    if (isClosing) {
      // Pop to the nearest matching opener, discarding anything left
      // stranded inside it. An unmatched closer is ignored, which is what
      // the HTML parser does too.
      const at = open.lastIndexOf(name);
      if (at !== -1) open.length = at;
      continue;
    }
    if (name === 'script' || name === 'style') {
      const end = rawTextElementEnd(html, name, i);
      i = end === -1 ? html.length : end;
      continue;
    }
    if (selfClosing || VOID_ELEMENTS.has(name)) continue;

    const implied = IMPLIED_END_TAGS.get(name);
    if (implied) {
      while (open.length > 0 && implied.has(open[open.length - 1] as string)) open.pop();
    }
    open.push(name);
    if (open.length > limit) return true;
  }
  return false;
}

/**
 * True when `html` nests elements deeper than `limit`. Exported so the
 * limit can be tested directly, including on shapes (unclosed `<li>`,
 * `<td>`, stray `<`) that must *not* trip it.
 */
export function exceedsNestingDepth(html: string, limit: number): boolean {
  return scanElements(html, limit);
}

const NAMED_ENTITIES = new Map<string, string>([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&apos;', "'"],
  ['&nbsp;', ' '],
]);

/**
 * Last-resort conversion for documents too deep to parse: keep the
 * character data, drop the markup. The result is poor Markdown but it is
 * bounded, linear, and preserves whatever prose the page held, which beats
 * both throwing the page away and stalling the process trying to do
 * better.
 */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  scanElements(html, Number.POSITIVE_INFINITY, (chunk) => parts.push(chunk));
  return parts
    .join(' ')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => NAMED_ENTITIES.get(m) ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
