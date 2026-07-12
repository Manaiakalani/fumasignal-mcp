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

interface Heading {
  depth: number;
  title: string;
  anchor: string;
  /** 0-based index into the line array this heading appears on. */
  line: number;
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
 * Scan markdown for headings (outside fenced code blocks), assigning each a
 * unique anchor. Anchors are de-duplicated globally (not just against same
 * "base" text) so a generated anchor like "foo-1" can never collide with
 * another heading whose own base anchor happens to already be "foo-1".
 *
 * `extractToc` and `extractSection` both build on this so the anchors they
 * report and the anchors they can look up by are always in sync.
 */
function collectHeadings(markdown: string): { lines: string[]; headings: Heading[] } {
  const lines = markdown.split(/\r?\n/);
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
  return { lines, headings };
}

export function extractToc(markdown: string): TocEntry[] {
  return collectHeadings(markdown).headings.map(({ depth, title, anchor }) => ({
    depth,
    title,
    anchor,
  }));
}

/**
 * Extract a section of markdown starting at the heading whose slug matches
 * `anchor`, ending at the next heading of equal-or-lesser depth.
 */
export function extractSection(
  markdown: string,
  anchor: string,
): { title: string; markdown: string } | null {
  const { lines, headings } = collectHeadings(markdown);
  const targetIdx = headings.findIndex((h) => h.anchor === anchor);
  if (targetIdx === -1) return null;
  const target = headings[targetIdx]!;

  let endIdx = lines.length;
  for (let j = targetIdx + 1; j < headings.length; j++) {
    if (headings[j]!.depth <= target.depth) {
      endIdx = headings[j]!.line;
      break;
    }
  }
  return {
    title: target.title,
    markdown: lines.slice(target.line, endIdx).join('\n').trim(),
  };
}
