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
  if (exceedsRenderBudget(stripped)) {
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

/**
 * Ceiling on how many elements may be handed to Turndown. Depth is not the
 * only way to make the parse expensive: a flat document never recurses, but
 * 100k siblings still cost ~3.7s and ~195MB, and the whole DOM is built
 * before Turndown's `remove()` list can discard any of it. 50k measures at
 * ~600ms/~97MB, which is the most we are willing to spend on one page.
 */
const MAX_DOCUMENT_ELEMENT_COUNT = 50_000;

/**
 * Ceiling on {@link htmlToText} output, so the fallback for a document we
 * already deemed abusive cannot itself grow without bound.
 */
const MAX_TEXT_OUTPUT_CHARS = 2_000_000;

/**
 * Elements whose content is not markup, so nothing inside them becomes a
 * node and nothing inside them may be scanned as if it were.
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * Elements Turndown drops wholesale (see {@link getTurndown}). Their content
 * still *parses* into nodes, so they count towards the limits, but their text
 * must not surface in the {@link htmlToText} fallback or the two paths would
 * disagree about what the page says.
 */
const DROPPED_SUBTREES = new Set(['script', 'style', 'noscript', 'iframe']);

/**
 * Elements that switch the parser into foreign content, where - unlike in
 * HTML - a trailing `/` really does self-close a tag. Inline `<svg>` icons
 * are everywhere in documentation, and refusing to honour `<path/>` there
 * would count one wasted level per icon and degrade ordinary pages.
 */
const FOREIGN_ROOTS = new Set(['svg', 'math']);

/**
 * Points inside foreign content where HTML parsing resumes, so a trailing
 * `/` stops being meaningful again. `HTML_INTEGRATION_POINTS` are the
 * container elements; `FOREIGN_BREAKOUT_TAGS` is HTML5's list of start tags
 * that force the parser out of foreign content wherever they appear. Without
 * the second list, one `<svg>` before the payload would exempt the whole rest
 * of the document from the depth limit.
 */
const HTML_INTEGRATION_POINTS = new Set([
  'foreignobject',
  'annotation-xml',
  'desc',
  // SVG's `<title>` is an integration point alongside `foreignObject` and
  // `desc`, so HTML resumes inside it. Omitting it kept `<svg><title>` in
  // foreign content, where a trailing `/` is honoured.
  'title',
  'mtext',
  'mi',
  'mo',
  'mn',
  'ms',
]);

const FOREIGN_BREAKOUT_TAGS = new Set([
  'b',
  'big',
  'blockquote',
  'body',
  'br',
  'center',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'i',
  'img',
  'li',
  'listing',
  'menu',
  'meta',
  'nobr',
  'ol',
  'p',
  'pre',
  'ruby',
  's',
  'small',
  'span',
  'strong',
  'strike',
  'sub',
  'sup',
  'table',
  'tt',
  'u',
  'ul',
  'var',
]);

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
 * `</p>` is optional before any of these, so `<p>intro<div>...` closes the
 * paragraph rather than nesting inside it. Counting it as nesting inflates
 * an ordinary page by one level per paragraph.
 */
for (const tag of [
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'pre',
  'section',
  'table',
  'ul',
]) {
  const closes = IMPLIED_END_TAGS.get(tag);
  if (closes) closes.add('p');
  else IMPLIED_END_TAGS.set(tag, new Set(['p']));
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

/** A tag name must begin with an ASCII letter; `<2`, `<-` and `<_` do not. */
function isNameStartChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

/** Characters that terminate a tag name: whitespace, `/`, or `>`. */
function isNameBoundary(code: number): boolean {
  return (
    code === 62 || // >
    code === 47 || // /
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 12 ||
    code === 13
  );
}

function isSpaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/**
 * Result of {@link tagEnd}, reused across a scan so the hot path allocates
 * nothing per tag.
 */
interface TagEnd {
  /** Index of the `>` that ends the tag, or -1 when it never ends. */
  end: number;
  /** True only for a genuine self-closing marker, per the tokenizer. */
  selfClosing: boolean;
}

/**
 * Locate the `>` that ends the tag whose name ended at `from`, and decide
 * whether the tag is genuinely self-closing, writing both into `out`.
 *
 * This walks attributes the way the tokenizer does instead of reaching for
 * the next `>`, because a quoted attribute value may contain one:
 * `<div title="></div>">` is a single tag, and stopping at the inner `>`
 * leaves `</div>">` to be rescanned as markup - which both invents a closing
 * tag that resets the depth stack and spills the attribute's text into the
 * {@link htmlToText} output. Quotes only open a value straight after `=`, so
 * an unquoted `x=a"b` cannot swallow the rest of the document either.
 *
 * The self-closing flag is set only when `/` appears where an attribute name
 * could start and is immediately followed by `>`. A `/` inside an unquoted
 * value is part of that value: `<g a=b/>` is **not** self-closing, and
 * reading it as such is what let `<svg>` + `<g a=b/>` nest unbounded.
 */
function tagEnd(html: string, from: number, out: TagEnd): void {
  out.selfClosing = false;
  let i = from;
  while (i < html.length) {
    while (i < html.length && isSpaceCode(html.charCodeAt(i))) i++;
    if (i >= html.length) break;
    const c = html.charCodeAt(i);
    if (c === 62) {
      out.end = i; // >
      return;
    }
    if (c === 47) {
      // Self-closing start tag state: only a `>` straight after the slash
      // sets the flag; anything else is a stray slash between attributes.
      if (html.charCodeAt(i + 1) === 62) {
        out.selfClosing = true;
        out.end = i + 1;
        return;
      }
      i++;
      continue;
    }
    // Attribute name.
    while (i < html.length) {
      const n = html.charCodeAt(i);
      if (n === 61 || n === 62 || n === 47 || isSpaceCode(n)) break;
      i++;
    }
    while (i < html.length && isSpaceCode(html.charCodeAt(i))) i++;
    if (i >= html.length) break;
    if (html.charCodeAt(i) !== 61) continue; // no '=': valueless attribute
    i++; // past '='
    while (i < html.length && isSpaceCode(html.charCodeAt(i))) i++;
    if (i >= html.length) break;
    const quote = html.charCodeAt(i);
    if (quote === 34 || quote === 39) {
      const close = html.indexOf(String.fromCharCode(quote), i + 1);
      if (close === -1) break; // value never closes, so the tag never does
      i = close + 1;
      continue;
    }
    // Unquoted value: `/` is an ordinary character here, not a marker.
    while (i < html.length) {
      const v = html.charCodeAt(i);
      if (v === 62 || isSpaceCode(v)) break;
      i++;
    }
  }
  out.end = -1;
}

/**
 * End of a raw-text element (`<script>`/`<style>`/`<textarea>`/`<title>`),
 * whose contents are not markup and must not be scanned as if they were.
 * Returns the index just past the closing tag, or -1 when it never closes.
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
    // The name only closes the element when a boundary follows it, so
    // `</script-x>` leaves `<script>` open exactly as the tokenizer does.
    if (
      matched === name.length &&
      (i >= html.length || isNameBoundary(html.charCodeAt(i)))
    ) {
      const gt = html.indexOf('>', i);
      return gt === -1 ? -1 : gt + 1;
    }
    cursor = lt + 2;
  }
}

/**
 * Walk `html` once, calling `onText` with each run of character data while
 * tracking element nesting depth and element count. Returns true as soon as
 * either limit is exceeded, stopping there.
 *
 * Deliberately a hand-rolled scanner rather than a parse: it is O(n) in the
 * input with no backtracking, allocates only the open-element stack, and is
 * the thing that runs *before* we are willing to pay for a real parse.
 * Unknown elements count towards depth, because the HTML parser nests them
 * like any other - a limit that only knew about known tag names would miss
 * `<x-a><x-a>...` entirely.
 *
 * It is a deliberately *conservative approximation*, and the direction of the
 * error is the whole point: it may report more depth than the DOM will really
 * have, never less. An earlier version tried to mirror HTML5 tree
 * construction, and every place it guessed low was a bypass - `<div/>` (HTML
 * ignores self-closing on non-void elements), `<div title=">">` (a `>` inside
 * a quoted value ended the tag early), `<b><i></b>` (the adoption agency
 * algorithm re-opens formatting elements, so the real tree gets *deeper*
 * while a pop-to-match stack empties) and `<!-->` (an abrupt closing of an
 * empty comment, read as one that never ends). Each let a document nesting
 * thousands deep slip past a limit of 500. Over-reporting only costs one page
 * its Markdown formatting; under-reporting hands this process a multi-second
 * synchronous stall or a `RangeError`.
 */
function scanElements(
  html: string,
  maxDepth: number,
  maxElements: number,
  onText?: (chunk: string) => void,
): boolean {
  const open: string[] = [];
  const tag: TagEnd = { end: -1, selfClosing: false };
  let elements = 0;
  // Stack height at which the nearest Turndown-dropped ancestor opened, or
  // -1 when there is none.
  let dropDepth = -1;
  // Stack height at which the nearest `<svg>`/`<math>` opened, or -1 when
  // ordinary HTML rules apply.
  // Whether each open element sits in foreign content, kept parallel to
  // `open` so that leaving an HTML island - `</title>` inside `<svg>` -
  // restores foreign mode instead of losing it for the rest of the document.
  const foreign: boolean[] = [];
  // Count of `<svg>`/`<math>` roots opened and not explicitly closed. Unlike
  // the per-element flag this is never cleared on a guess, so it can only
  // over-state how much of the document is foreign - the safe direction for
  // the one decision that would otherwise skip unbounded markup.
  let foreignOpen = 0;
  // Cleared for good by a `</svg>`/`</math>` that matches nothing, which
  // returns the real parser to HTML from a nesting level this scanner cannot
  // identify. From then on no trailing `/` is honoured anywhere, which can
  // only over-count.
  let foreignTrusted = true;
  const emit = (chunk: string): void => {
    if (dropDepth === -1) onText?.(chunk);
  };
  const popOne = (): void => {
    open.pop();
    foreign.pop();
    if (dropDepth !== -1 && open.length <= dropDepth) dropDepth = -1;
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      emit(html.slice(i));
      break;
    }
    if (lt > i) emit(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      // `<!-->` and `<!--->` are complete comments ("abrupt closing of empty
      // comment"), not the start of one that never ends. Reading them as
      // unterminated swallows the rest of the document, and everything the
      // scanner then fails to see is depth it fails to count.
      if (html.startsWith('<!-->', lt)) {
        i = lt + 5;
        continue;
      }
      if (html.startsWith('<!--->', lt)) {
        i = lt + 6;
        continue;
      }
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
    if (!isNameStartChar(html.charCodeAt(nameStart))) {
      // HTML5 only opens a tag when an ASCII letter follows the `<`, so
      // `1<2` keeps its text and `<1>` is not an element. An end tag that
      // starts with anything else is a bogus comment: consumed to the next
      // `>` rather than emitted as text.
      if (isClosing) {
        const end = html.indexOf('>', nameStart);
        i = end === -1 ? html.length : end + 1;
        continue;
      }
      emit('<');
      i = lt + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    tagEnd(html, nameEnd, tag);
    if (tag.end === -1) break; // unterminated tag: nothing further is markup
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const selfClosing = tag.selfClosing;
    i = tag.end + 1;

    if (isClosing) {
      // A foreign root's end tag returns the real parser to HTML even when it
      // matches nothing on this stack, so `<svg><g></svg>` must not leave the
      // scanner in foreign content. Where it matches nothing there is no way
      // to tell which open elements it closed, so self-closing markers stop
      // being honoured entirely rather than being honoured in the wrong
      // namespace.
      if (FOREIGN_ROOTS.has(name)) {
        if (foreignOpen > 0) foreignOpen--;
        if (!(open.length > 0 && open[open.length - 1] === name)) foreignTrusted = false;
      }
      // Only ever pop an exact match for the innermost element. Popping to a
      // match deeper in the stack is what the parser does for ordinary
      // elements, but for mis-nested formatting elements it re-opens them
      // instead, so assuming the shallower reading is unsafe. Leaving the
      // stack alone over-reports depth, which is the side to be wrong on.
      if (open.length > 0 && open[open.length - 1] === name) popOne();
      continue;
    }

    elements++;
    if (elements > maxElements) return true;

    // Raw text is an HTML-namespace rule only. Inside `<svg>`/`<math>`,
    // `<title>`, `<style>` and `<textarea>` are ordinary containers whose
    // markup really does nest, so skipping their contents there reported
    // `<svg><title>` + 3,000 `<div>` as depth 1 and two elements, escaping
    // the depth *and* element caps at once.
    //
    // This deliberately tests `foreignOpen` rather than the per-element flag.
    // The two have to be wrong in opposite directions: the flag tracks where
    // HTML resumes and is cleared on more tags than the spec strictly
    // requires, which is safe for the self-closing decision below - guessing
    // "not foreign" only ever counts more depth - but is exactly backwards
    // here, where believing HTML has resumed skips an unbounded amount of
    // markup. `foreignOpen` counts only roots and is never cleared
    // optimistically, so it can only ever suppress the skip.
    if (foreignOpen === 0 && RAW_TEXT_ELEMENTS.has(name)) {
      // Content is character data: it creates no nodes, must not be scanned
      // as markup, and is not part of the page's prose.
      const end = rawTextElementEnd(html, name, i);
      i = end === -1 ? html.length : end;
      continue;
    }

    // Foreign content is the only place a trailing `/` self-closes. HTML5
    // leaves foreign content on any of ~45 start tags as well as at the
    // integration points, so this has to be checked on every element: without
    // it, a single `<svg>` before the payload would exempt the whole rest of
    // the document from the limit.
    const inForeign = open.length > 0 && foreign[open.length - 1] === true;
    let honourSelfClosing = false;
    let opensForeign = inForeign;
    if (inForeign) {
      if (FOREIGN_BREAKOUT_TAGS.has(name) || HTML_INTEGRATION_POINTS.has(name)) {
        opensForeign = false; // HTML resumes here; back to the strict reading
      } else if (foreignTrusted) {
        honourSelfClosing = selfClosing;
      }
    } else if (FOREIGN_ROOTS.has(name)) {
      if (selfClosing && foreignTrusted) continue; // `<svg/>` opens nothing
      opensForeign = true;
      foreignOpen++;
    }

    // Optional end tags resolve before the void check, so a void `<hr>` still
    // closes an open `<p>`. They are an HTML-only rule: inside `<svg>`/
    // `<math>` the stack must be left alone, since popping there would
    // under-report depth.
    if (!inForeign) {
      const implied = IMPLIED_END_TAGS.get(name);
      if (implied) {
        while (open.length > 0 && implied.has(open[open.length - 1] as string)) popOne();
      }
    }

    // A `/` before the `>` is ignored on ordinary HTML elements, so `<div/>`
    // opens a `<div>` like any other. Only genuinely void elements stay
    // flat - and, in foreign content, genuinely self-closed ones.
    if (VOID_ELEMENTS.has(name)) continue;
    if (honourSelfClosing) continue;

    if (dropDepth === -1 && DROPPED_SUBTREES.has(name)) dropDepth = open.length;
    open.push(name);
    foreign.push(opensForeign);
    if (open.length > maxDepth) return true;
  }
  return false;
}

/**
 * True when `html` nests elements deeper than `limit`. Exported so the
 * limit can be tested directly, including on shapes (unclosed `<li>`,
 * `<td>`, stray `<`) that must *not* trip it.
 */
export function exceedsNestingDepth(html: string, limit: number): boolean {
  return scanElements(html, limit, Number.POSITIVE_INFINITY);
}

/**
 * True when `html` is too deep or too large to hand to Turndown. Both limits
 * matter: depth becomes call-stack depth in Turndown's recursive walk, and
 * sheer element count becomes parse time and heap before Turndown runs at all.
 */
export function exceedsRenderBudget(html: string): boolean {
  return scanElements(html, MAX_DOCUMENT_NESTING_DEPTH, MAX_DOCUMENT_ELEMENT_COUNT);
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
  // Accumulated as one rope rather than an array of fragments: a document
  // that reaches this path is already adversarial, and `<b>x</b>` repeated a
  // million times would otherwise cost far more in per-string overhead than
  // in text. The cap bounds the fallback for a page we have already judged
  // abusive.
  let out = '';
  scanElements(html, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, (chunk) => {
    if (out.length >= MAX_TEXT_OUTPUT_CHARS) return;
    out = out.length === 0 ? chunk : `${out} ${chunk}`;
  });
  return out
    .slice(0, MAX_TEXT_OUTPUT_CHARS)
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => NAMED_ENTITIES.get(m) ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
