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
