/**
 * Shared helpers for slicing strings without splitting a UTF-16 surrogate
 * pair. Strings are sequences of UTF-16 code units, not code points: an
 * emoji or other supplementary-plane character is stored as a high
 * surrogate (0xD800-0xDBFF) followed by a low surrogate (0xDC00-0xDFFF),
 * and naively cutting at an arbitrary offset can land between the two.
 * That leaves a dangling lone surrogate in the sliced string, which is not
 * well-formed Unicode and can render as U+FFFD or confuse a downstream
 * JSON/UTF-8 encoder. Every truncation/excerpt site in this codebase that
 * computes an offset into arbitrary (attacker-influenced) text should use
 * these instead of a raw `.slice()` bound.
 */

/**
 * Return a cut length `<= max` such that `text.slice(0, cut)` never splits
 * a UTF-16 surrogate pair. Use this for the *end* (tail) side of a slice.
 */
export function safeTruncateLength(text: string, max: number): number {
  if (max <= 0 || max >= text.length) return Math.max(0, Math.min(max, text.length));
  const before = text.charCodeAt(max - 1);
  return before >= 0xd800 && before <= 0xdbff ? max - 1 : max;
}

/**
 * Return a start offset `>= start` such that `text.slice(start, ...)` never
 * *begins* with a dangling low surrogate. Use this for the *start* (head)
 * side of a slice whose lower bound isn't fixed at 0 (e.g. a search
 * excerpt/snippet window) - `safeTruncateLength()` alone only protects the
 * tail. Advances past the orphaned low surrogate (rather than pulling the
 * high surrogate back in) so the returned offset never *decreases* below
 * the requested `start`.
 */
export function safeSliceStart(text: string, start: number): number {
  if (start <= 0 || start >= text.length) return Math.max(0, Math.min(start, text.length));
  const at = text.charCodeAt(start);
  return at >= 0xdc00 && at <= 0xdfff ? start + 1 : start;
}
