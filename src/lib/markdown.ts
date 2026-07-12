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

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^```/;

interface Heading {
  depth: number;
  title: string;
  anchor: string;
  /** 0-based index into the line array this heading appears on. */
  line: number;
}

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
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const depth = m[1]!.length;
    const title = m[2]!.trim();
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
