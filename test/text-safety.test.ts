import { describe, it, expect } from 'vitest';
import { safeTruncateLength, safeSliceStart } from '../src/lib/text-safety.js';

describe('safeTruncateLength', () => {
  it('returns max unchanged when the cut does not split a surrogate pair', () => {
    expect(safeTruncateLength('hello world', 5)).toBe(5);
  });

  it('backs off by one when the cut would split a surrogate pair', () => {
    const text = `ab${'😀'}cd`; // 'a','b',hi,lo,'c','d' -> length 6
    // cutting at 3 would land after the high surrogate (index 2) and
    // before its low surrogate (index 3) - i.e. slice(0,3) would end
    // with a dangling high surrogate.
    expect(safeTruncateLength(text, 3)).toBe(2);
  });

  it('leaves a cut that lands exactly on a pair boundary unchanged', () => {
    const text = `ab${'😀'}cd`;
    expect(safeTruncateLength(text, 4)).toBe(4); // right after the full emoji
    expect(safeTruncateLength(text, 2)).toBe(2); // right before the emoji
  });

  it('clamps max to [0, text.length]', () => {
    expect(safeTruncateLength('abc', -5)).toBe(0);
    expect(safeTruncateLength('abc', 100)).toBe(3);
  });

  it('never produces a slice(0, cut) with a dangling high surrogate, fuzzed', () => {
    const emoji = ['😀', '🎉', '🚀', '💡'];
    for (let trial = 0; trial < 200; trial++) {
      let text = '';
      for (let i = 0; i < 20; i++) {
        text += Math.random() < 0.5 ? 'x' : emoji[Math.floor(Math.random() * emoji.length)];
      }
      for (let max = 0; max <= text.length; max++) {
        const cut = safeTruncateLength(text, max);
        const sliced = text.slice(0, cut);
        const last = sliced.charCodeAt(sliced.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });
});

describe('safeSliceStart', () => {
  it('returns start unchanged when it does not split a surrogate pair', () => {
    expect(safeSliceStart('hello world', 5)).toBe(5);
  });

  it('advances by one when start would begin with a dangling low surrogate', () => {
    const text = `ab${'😀'}cd`; // indices: a=0 b=1 hi=2 lo=3 c=4 d=5
    expect(safeSliceStart(text, 3)).toBe(4);
  });

  it('leaves a start that lands exactly on a pair boundary unchanged', () => {
    const text = `ab${'😀'}cd`;
    expect(safeSliceStart(text, 2)).toBe(2); // right at the emoji's high surrogate
    expect(safeSliceStart(text, 4)).toBe(4); // right after the emoji
  });

  it('clamps start to [0, text.length]', () => {
    expect(safeSliceStart('abc', -5)).toBe(0);
    expect(safeSliceStart('abc', 100)).toBe(3);
  });

  it('never produces a slice(start) with a dangling low surrogate, fuzzed', () => {
    const emoji = ['😀', '🎉', '🚀', '💡'];
    for (let trial = 0; trial < 200; trial++) {
      let text = '';
      for (let i = 0; i < 20; i++) {
        text += Math.random() < 0.5 ? 'x' : emoji[Math.floor(Math.random() * emoji.length)];
      }
      for (let start = 0; start <= text.length; start++) {
        const safeStart = safeSliceStart(text, start);
        const sliced = text.slice(safeStart);
        const first = sliced.charCodeAt(0);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      }
    }
  });
});
