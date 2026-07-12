import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, pickArticle, stripChrome } from '../src/lib/html-to-md.js';

describe('pickArticle', () => {
  it('extracts the content of an <article> tag', () => {
    expect(pickArticle('<div><article>hello</article></div>')).toBe('hello');
  });

  it('picks the largest match when multiple exist', () => {
    const html =
      '<article>short</article><article>this one is the longest by far and should win</article>';
    expect(pickArticle(html)).toBe('this one is the longest by far and should win');
  });

  it('falls back to <main> when there is no <article>', () => {
    expect(pickArticle('<div><main>main content</main></div>')).toBe('main content');
  });

  it('returns the full html when neither tag is present', () => {
    const html = '<div>no article or main here</div>';
    expect(pickArticle(html)).toBe(html);
  });

  it('is case-insensitive and tolerates attributes on the opening tag', () => {
    expect(pickArticle('<ARTICLE class="x" data-y="z">content</ARTICLE>')).toBe('content');
  });

  it('leaves an unclosed tag unmatched (falls through, does not hang)', () => {
    const html = '<article>never closed';
    expect(pickArticle(html)).toBe(html);
  });

  it('matches the original lazy-regex non-nesting-aware behavior for nested same tags', () => {
    // Historical behavior (regex `<article\b[^>]*>([\s\S]*?)<\/article>`):
    // the lazy group stops at the FIRST closer, so nested same-name tags
    // resolve to the outer opener + inner closer, leaving a dangling
    // closer as leftover. The linear rewrite intentionally preserves this
    // rather than attempting real nesting-aware parsing (out of scope -
    // this is regex-based best-effort extraction, not an HTML parser).
    const html = '<article><article>inner</article></article>';
    expect(pickArticle(html)).toBe('<article>inner');
  });

  it('does not exhibit quadratic blowup on adversarial input (many unclosed openers)', () => {
    // Regression for a confirmed O(n^2) blowup in the old implementation
    // (~2.4s for 720KB of repeated unclosed openers). The linear two-pointer
    // rewrite should handle several MB in well under a second.
    const opener = '<article class="deeply-nested-attr-value-here">';
    const html = opener.repeat(Math.ceil((2_000_000) / opener.length));
    const start = performance.now();
    pickArticle(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not exhibit quadratic blowup on adversarial input with no ">" anywhere (opening-tag-regex bug)', () => {
    // Regression: distinct from the test above, which uses openers like
    // '<article class="...">' that already contain their own closing '>'
    // and so only exercise the *closing*-tag-search fix. This uses
    // openers with NO '>' character anywhere in the whole string, which
    // the old `<tag\b[^>]*>` *opening*-tag regex had its own independent
    // O(n^2) blowup on (~5.5s for just 200KB) - the opening-tag search
    // itself was never fixed until this rewrite.
    const opener = '<article';
    const html = opener.repeat(Math.ceil(500_000 / opener.length));
    const start = performance.now();
    const result = pickArticle(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // No '>' anywhere means no opening tag ever completes, so it falls
    // through unmatched - same contract as the "unclosed tag" test above.
    expect(result).toBe(html);
  });

  it('short-circuits quickly for a large document containing neither <article> nor <main> at all (allocation-avoidance regression)', () => {
    // Regression: findLargestTagBlock() unconditionally built two full
    // position arrays over the *entire* document - one entry per every
    // literal '>' anywhere in it, via findAngleClosePositions() - before
    // ever checking whether the target tag was present at all.
    // pickArticle() tries up to 2 tags per call; a page with neither
    // <article> nor <main> (common on non-Fumadocs sites) paid for two
    // full-document scan-and-allocate passes for nothing. Empirically, a
    // 10MB string of pure '>' characters measured ~163ms and ~208MB of
    // heap for *one* such scan. A large tag-free document must now
    // resolve near-instantly and be returned unchanged.
    const html = '<div>' + '>'.repeat(10_000_000) + '</div>';
    const start = performance.now();
    const result = pickArticle(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toBe(html);
  });

  it('stays fast and does not blow up memory when the target tag appears just once amid a huge amount of unrelated ">" characters (existence-precheck-bypass regression)', () => {
    // Regression: the "tag entirely absent" pre-check above only helps
    // when `tag` never appears at all. Once the tag genuinely appears
    // even a single time, the *old* implementation still unconditionally
    // built a position array over every literal '>' in the *entire*
    // remaining document via findAngleClosePositions(), regardless of
    // how far away those '>' characters were from any real opener/
    // closer. Empirically confirmed against the pre-fix logic: one real
    // <article> tag followed by 8MB of unrelated '>' padding measured
    // ~233MB of heap - almost identical to the "no tag at all" case
    // above, because the fix for *that* case didn't help once the tag
    // was actually present. The lazy, on-demand finders this was
    // rewritten to use must only ever scan as far as the real match
    // requires, so a genuine tag followed by a large amount of unrelated
    // trailing content must resolve near-instantly, not scale with how
    // much unrelated content follows it.
    const html = '<article>hello</article>' + '>'.repeat(8_000_000);
    const start = performance.now();
    const result = pickArticle(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toBe('hello');
  });
});

describe('stripChrome', () => {
  it('removes a single chrome block', () => {
    expect(stripChrome('<p>keep</p><nav>gone</nav>')).toBe('<p>keep</p>');
  });

  it('removes multiple non-overlapping blocks across different tags', () => {
    const html = '<p>keep1</p><nav>a</nav><p>keep2</p><footer>b</footer><p>keep3</p>';
    expect(stripChrome(html)).toBe('<p>keep1</p><p>keep2</p><p>keep3</p>');
  });

  it('is case-insensitive', () => {
    expect(stripChrome('<P>keep</P><NAV>gone</NAV>')).toBe('<P>keep</P>');
  });

  it('leaves an unclosed chrome tag untouched', () => {
    const html = '<p>keep</p><nav>unclosed forever';
    expect(stripChrome(html)).toBe(html);
  });

  it('does not exhibit quadratic blowup on adversarial input (many unclosed openers)', () => {
    const opener = '<nav class="deeply-nested-attr-value-here">';
    const html = opener.repeat(Math.ceil(2_000_000 / opener.length));
    const start = performance.now();
    stripChrome(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not exhibit quadratic blowup on adversarial input with no ">" anywhere (opening-tag-regex bug)', () => {
    // Regression: distinct from the test above (whose opener already
    // contains its own '>'), this exercises the *opening*-tag search's
    // independent O(n^2) blowup on input with no '>' character reachable
    // anywhere - see the matching pickArticle test for the full mechanism.
    const opener = '<nav';
    const html = opener.repeat(Math.ceil(500_000 / opener.length));
    const start = performance.now();
    const result = stripChrome(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // No '>' anywhere means no opening tag ever completes, so nothing is
    // removed - same contract as the "unclosed chrome tag" test above.
    expect(result).toBe(html);
  });

  it('short-circuits quickly for a large document containing none of the stripped chrome tags at all (allocation-avoidance regression)', () => {
    // Same fast-path fix as pickArticle's matching test, but for
    // removeTagBlocks()/stripChrome(), which tries up to 6 tags per call
    // (nav, aside, header, footer, script, style, noscript) - so a
    // tag-free page previously paid for up to 6 wasted full-document
    // scan-and-allocate passes instead of just 2.
    const html = '<div>' + '>'.repeat(10_000_000) + '</div>';
    const start = performance.now();
    const result = stripChrome(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toBe(html);
  });

  it('stays fast when a stripped tag appears just once amid a huge amount of unrelated ">" characters (existence-precheck-bypass regression)', () => {
    // Same blind spot as pickArticle's matching test: once a tag is
    // confirmed present, the old removeTagBlocks() still unconditionally
    // scanned the *entire* remaining document for every literal '>'
    // before ever using the tag's own position. A single real <nav>
    // block followed by a large amount of unrelated trailing content
    // must resolve near-instantly and correctly remove just that block.
    const padding = '>'.repeat(8_000_000);
    const html = '<nav>chrome</nav>' + padding;
    const start = performance.now();
    const result = stripChrome(html);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result).toBe(padding);
  });
});

describe('htmlToMarkdown', () => {
  it('converts a realistic doc page to markdown, stripping nav/footer chrome', () => {
    const html = `<html><body><nav>site nav</nav><article><h1>Title</h1><p>Hello <strong>world</strong></p></article><footer>footer</footer></body></html>`;
    const md = htmlToMarkdown(html);
    expect(md).toContain('# Title');
    expect(md).toContain('Hello **world**');
    expect(md).not.toContain('site nav');
    expect(md).not.toContain('footer');
  });
});
