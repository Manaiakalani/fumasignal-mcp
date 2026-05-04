export interface TocEntry {
  depth: number;
  title: string;
  anchor: string;
}

const ANCHOR_NON_WORD = /[^\w\s-]/g;
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

export function extractToc(markdown: string): TocEntry[] {
  const lines = markdown.split(/\r?\n/);
  const out: TocEntry[] = [];
  let inFence = false;
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const depth = m[1]!.length;
    const title = m[2]!.trim();
    let anchor = slugify(title);
    if (!anchor) continue;
    const baseAnchor = anchor;
    const count = seen.get(baseAnchor) ?? 0;
    if (count > 0) anchor = `${baseAnchor}-${count}`;
    seen.set(baseAnchor, count + 1);
    out.push({ depth, title, anchor });
  }
  return out;
}

/**
 * Extract a section of markdown starting at the heading whose slug matches
 * `anchor`, ending at the next heading of equal-or-lesser depth.
 */
export function extractSection(
  markdown: string,
  anchor: string,
): { title: string; markdown: string } | null {
  const toc = extractToc(markdown);
  const target = toc.find((t) => t.anchor === anchor);
  if (!target) return null;

  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let startIdx = -1;
  let endIdx = lines.length;
  let occurrenceMatch = 0;
  const baseAnchor = slugify(target.title);
  const dupeMatch = /-(\d+)$/.exec(anchor);
  const wantedOccurrence =
    anchor === baseAnchor ? 0 : dupeMatch ? Number(dupeMatch[1]) : 0;

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
    if (startIdx === -1) {
      if (depth === target.depth && slugify(title) === baseAnchor) {
        if (occurrenceMatch === wantedOccurrence) {
          startIdx = i;
        } else {
          occurrenceMatch++;
        }
      }
    } else if (depth <= target.depth) {
      endIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;
  return {
    title: target.title,
    markdown: lines.slice(startIdx, endIdx).join('\n').trim(),
  };
}
