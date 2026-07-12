export interface TocEntry {
  depth: number;
  title: string;
  anchor: string;
}

// Strip anything that isn't a Unicode letter/number, whitespace, underscore,
// or hyphen. Using \p{L}/\p{N} (instead of \w) keeps non-Latin headings
// (e.g. CJK, Cyrillic, Arabic) from being slugified into an empty string.
const ANCHOR_NON_WORD = /[^\p{L}\p{N}\s_-]/gu;
const ANCHOR_WHITESPACE = /\s+/g;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(ANCHOR_NON_WORD, '')
    .replace(ANCHOR_WHITESPACE, '-');
}

// Only the marker+required-whitespace prefix is matched by regex; the
// optional ATX closing sequence ("## Title ##") is stripped afterward
// with plain string operations instead of folding it into one pattern.
// The previous version, `/^(#{1,6})\s+(.+?)\s*#*\s*$/`, put a lazy
// group immediately before *three* quantifiers that can all match the
// same whitespace/"#" characters it can - the same catastrophic-
// backtracking shape documented (and fixed) for `LOC_RE` in
// src/lib/sitemap.ts. Empirically confirmed here too: a single 5KB
// line of "# a" + padding spaces + "!" (no valid closing sequence, so
// the engine must exhaust every way to split the ambiguous region
// before failing) took ~36s to reject; 10KB exceeded 120s. See
// `stripAtxClosingSequence` below for the replacement.
const HEADING_PREFIX_RE = /^(#{1,6})\s+/;
const FENCE_RE = /^```/;

/**
 * Strip an optional ATX heading closing sequence - trailing whitespace,
 * then trailing "#"s, then more trailing whitespace (e.g. "Title ##" ->
 * "Title") - matching what `(.+?)\s*#*\s*$` used to capture. Uses
 * `trimEnd()` and a plain character scan instead of regex `.replace()`:
 * an *unanchored* `/\s+$/` or `/#+$/` still retries at every position
 * within a long run before giving up if the string doesn't actually end
 * in that character (exactly the input this function receives when the
 * ReDoS attack has no valid closing sequence), reproducing the same
 * quadratic blowup this function exists to avoid. `trimEnd()` and a
 * `while` loop bounded by the string's own length can't backtrack, so
 * both stay linear no matter what `text` contains.
 */
function stripAtxClosingSequence(text: string): string {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 0x23 /* '#' */) end--;
  return trimmed.slice(0, end).trimEnd();
}

export interface Heading {
  depth: number;
  title: string;
  anchor: string;
  /** 0-based index into the line array this heading appears on. */
  line: number;
}

/**
 * The result of scanning a document once for its lines/headings - see
 * `buildHeadingIndex()`. Exported so callers (local.ts/remote.ts) can hold
 * on to one of these per cached page and reuse it across repeated
 * `getToc()`/`getSection()` calls instead of re-scanning the same markdown
 * from scratch every time.
 */
export interface HeadingIndex {
  lines: string[];
  headings: Heading[];
  /**
   * True if the source document had more lines than `MAX_LINES` and was
   * cut off before every line was scanned/retained. When true, headings
   * (and therefore sections) beyond the retained portion don't exist in
   * this index at all - see `sectionFromHeadingIndex()`'s use of this
   * flag to caveat the one section whose true end is actually ambiguous
   * as a result (the last one found, which may have been cut off mid-
   * section rather than ending where the document itself ends).
   */
  truncated: boolean;
}

/**
 * Upper bound on how many headings `collectHeadings()` will ever record for
 * one document. Without this, an adversarial-but-plausible input - e.g. a
 * file consisting of many one-line "# x" headings, well within
 * `maxFileBytes` on its own (4 bytes per heading; a 10MB file could hold
 * ~2.5 million of them) - can produce a headings/anchors/TOC set numbering
 * in the millions. Each entry is small, but `local.ts`/`remote.ts` both
 * hold every indexed page's `toc` in memory for the process's lifetime
 * with no eviction (see their own doc comments), so that many small
 * objects for a *single* page still adds up to on the order of a hundred+
 * MB retained indefinitely - well beyond what a byte-size cap on the
 * source file alone would suggest is possible. 5,000 is generous enough
 * that no real documentation page comes remotely close (a page with
 * anywhere near that many headings would already be unusable as a single
 * document rendered by any normal viewer), while bounding the pathological
 * case to a small, predictable multiple of a reasonable page's actual
 * heading count.
 */
const MAX_HEADINGS = 5000;

/**
 * Upper bound on how many lines of a document `collectHeadings()` will
 * scan and retain in the returned `HeadingIndex.lines`. Without this, an
 * adversarial-but-plausible input - e.g. a file that's mostly newlines,
 * well within `maxFileBytes`/`maxResponseBytes` on its own - splits into
 * millions of (mostly empty) array entries that are then retained for
 * the process's lifetime as part of the cached `HeadingIndex` (see its
 * doc comment), long after `MAX_HEADINGS` above would have kicked in (a
 * file with few/no actual headings never reaches it, since that bound
 * only counts *headings found*, not lines scanned). Empirically
 * confirmed: a 10MB input consisting of ~5,000,000 newlines retained a
 * `lines` array that added ~85MB to the heap, indefinitely, for a
 * single page - and `maxTotalBytes` permits many such files at once, so
 * this is a real amplification of the byte caps rather than a one-off.
 * 50,000 is far beyond any real documentation page's line count (a page
 * with anywhere near that many lines would be unusable as a single
 * document in any normal viewer), matching `MAX_HEADINGS`'s own
 * reasoning: bound the pathological case to a small, predictable
 * multiple of a reasonable page's actual size, not the raw byte cap.
 */
const MAX_LINES = 50_000;

/**
 * Scan markdown for headings (outside fenced code blocks), assigning each a
 * unique anchor. Anchors are de-duplicated globally (not just against same
 * "base" text) so a generated anchor like "foo-1" can never collide with
 * another heading whose own base anchor happens to already be "foo-1".
 *
 * `extractToc` and `extractSection` both build on this so the anchors they
 * report and the anchors they can look up by are always in sync.
 */
function collectHeadings(markdown: string): HeadingIndex {
  const allLines = markdown.split(/\r?\n/);
  const truncated = allLines.length > MAX_LINES;
  // Slicing (rather than just scanning fewer of `allLines`) lets the
  // original, potentially huge array be garbage-collected once this
  // function returns, instead of keeping it alive as part of `lines`'
  // backing store - see MAX_LINES's doc comment for why that matters.
  const lines = truncated ? allLines.slice(0, MAX_LINES) : allLines;
  const headings: Heading[] = [];
  let inFence = false;
  const nextSuffix = new Map<string, number>();
  const usedAnchors = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (headings.length >= MAX_HEADINGS) break;
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_PREFIX_RE.exec(line);
    if (!m) continue;
    const depth = m[1]!.length;
    const title = stripAtxClosingSequence(line.slice(m[0].length)).trim();
    if (!title) continue;
    const base = slugify(title);
    if (!base) continue;
    let suffix = nextSuffix.get(base) ?? 0;
    let anchor = suffix > 0 ? `${base}-${suffix}` : base;
    while (usedAnchors.has(anchor)) {
      suffix++;
      anchor = `${base}-${suffix}`;
    }
    nextSuffix.set(base, suffix + 1);
    usedAnchors.add(anchor);
    headings.push({ depth, title, anchor, line: i });
  }
  return { lines, headings, truncated };
}

/**
 * Scan `markdown` once for its lines/headings, in a form cheap to hold on
 * to and reuse. Callers that will need *both* a TOC and (potentially
 * several) section lookups for the same document - or that already cache
 * the document itself and can cache this alongside it - should call this
 * once and pass the result to `tocFromHeadingIndex()`/
 * `sectionFromHeadingIndex()` instead of calling `extractToc()`/
 * `extractSection()` (which each re-scan from scratch) repeatedly.
 *
 * This was empirically the difference between a one-time, index-build-time
 * cost and a *repeated-per-request* one: `getSection()` in both
 * local.ts/remote.ts otherwise called `extractSection()` - and therefore
 * re-ran the full `.split(/\r?\n/)` and heading scan below - on every
 * single `get_section` tool call, even for a page whose body/TOC was
 * already fully cached.
 */
export function buildHeadingIndex(markdown: string): HeadingIndex {
  return collectHeadings(markdown);
}

export function tocFromHeadingIndex(index: HeadingIndex): TocEntry[] {
  return index.headings.map(({ depth, title, anchor }) => ({ depth, title, anchor }));
}

/**
 * Extract a section of markdown starting at the heading whose slug matches
 * `anchor`, ending at the next heading of equal-or-lesser depth.
 */
export function sectionFromHeadingIndex(
  index: HeadingIndex,
  anchor: string,
): { title: string; markdown: string } | null {
  const { lines, headings, truncated } = index;
  const targetIdx = headings.findIndex((h) => h.anchor === anchor);
  if (targetIdx === -1) return null;
  const target = headings[targetIdx]!;

  let endIdx = lines.length;
  let hasFollowingHeading = false;
  for (let j = targetIdx + 1; j < headings.length; j++) {
    if (headings[j]!.depth <= target.depth) {
      endIdx = headings[j]!.line;
      hasFollowingHeading = true;
      break;
    }
  }
  let markdown = lines.slice(target.line, endIdx).join('\n').trim();
  // Only the section that runs all the way to the end of the *retained*
  // lines has an ambiguous true end when the document was truncated: an
  // earlier section's end is always a heading position found within the
  // safely-scanned portion, so truncation elsewhere in the document can't
  // affect it. This section's real content past MAX_LINES - which may
  // contain more of the same section, or the next heading that would
  // otherwise have closed it - was never scanned, so presenting it as
  // complete would be misleading.
  if (truncated && !hasFollowingHeading) {
    markdown += `\n\n…[document exceeds the ${MAX_LINES}-line indexing limit; this section may be incomplete]`;
  }
  return { title: target.title, markdown };
}

/**
 * Convenience one-shot wrapper for callers that only need a TOC once and
 * have no reason to hold on to a `HeadingIndex` (e.g. tests, or a single
 * ad hoc lookup). Prefer `buildHeadingIndex()` + `tocFromHeadingIndex()`/
 * `sectionFromHeadingIndex()` when both a TOC and section lookups are
 * needed for the same document, or when the caller can cache the index
 * itself - see their doc comments.
 */
export function extractToc(markdown: string): TocEntry[] {
  return tocFromHeadingIndex(buildHeadingIndex(markdown));
}

/** One-shot wrapper around `sectionFromHeadingIndex()` - see its doc comment. */
export function extractSection(
  markdown: string,
  anchor: string,
): { title: string; markdown: string } | null {
  return sectionFromHeadingIndex(buildHeadingIndex(markdown), anchor);
}
