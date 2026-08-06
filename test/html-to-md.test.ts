import { describe, it, expect } from 'vitest';
import {
  htmlToMarkdown,
  pickArticle,
  stripChrome,
  exceedsNestingDepth,
  exceedsRenderBudget,
  htmlToText,
} from '../src/lib/html-to-md.js';

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

  it('pairs nested same-name tags by depth instead of stopping at the first closer', () => {
    // Regression: the previous implementation paired every opener with
    // whatever `</article>` came next, with no notion of depth, so the
    // OUTER article was treated as ending at the INNER article's closer.
    // The extracted body stopped there and everything after it was
    // dropped - on a real docs page using an `<article>` card list inside
    // its own `<article>`, that silently discarded the rest of the page.
    const html = '<article><article>inner</article></article>';
    expect(pickArticle(html)).toBe('<article>inner</article>');
  });

  it('keeps content that follows a nested block inside the same outer tag', () => {
    // The concrete data-loss shape: "3" (and, on a real page, everything
    // after the nested block) used to be discarded entirely.
    const html = '<article>1<article>2</article>3</article>';
    expect(pickArticle(html)).toBe('1<article>2</article>3');
  });

  it('does not mistake a closer inside an opening tag\u2019s attribute for the block closer', () => {
    // `>`-finding is attribute-unaware (unchanged, longstanding behavior
    // of this best-effort regex extraction - a real HTML parser would
    // skip quoted attribute values), so the opening tag is considered to
    // end at the `>` inside the attribute and the leading `">` bleeds
    // into the content. What matters here is the pairing: the
    // `</article>` sitting inside that attribute is NOT taken as the
    // block's closing tag, so the body still survives instead of
    // collapsing to an empty match.
    const html = '<article title="</article>">body</article>';
    expect(pickArticle(html)).toBe('">body');
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

  it('keeps stripping chrome after a custom element whose name merely starts with a strip tag', () => {
    // Regression: the opener pattern used `<nav\b`, and `\b` fires between
    // "v" and "-", so `<nav-bar>` was read as an opening <nav>. Its closer
    // `</nav-bar>` matched nothing, leaving that phantom opener on the
    // stack forever - so every later, properly-formed <nav> was reported
    // at a non-zero depth and skipped, silently disabling chrome-stripping
    // for the rest of the page. A tag name ends at whitespace, "/" or ">".
    const out = stripChrome('<nav-bar>x</nav-bar><nav>CHROME</nav>keep');
    expect(out).not.toContain('CHROME');
    expect(out).toContain('keep');
  });

  it('does not treat a longer tag name as a strip tag', () => {
    expect(stripChrome('<navigation>keep me</navigation>')).toContain('keep me');
  });

  it('removes a block whose end tag carries whitespace before the ">"', () => {
    // HTML5 allows `</nav >`; missing it stranded the opener on the stack
    // with the same knock-on effect as above.
    const out = stripChrome('<nav >CHROME</nav >keep');
    expect(out).not.toContain('CHROME');
    expect(out).toContain('keep');
  });

  it('still removes later blocks when an earlier opener is never closed', () => {
    // Depth is only meaningful when the stack actually balances. An opener
    // with no closer is never popped, so a depth-based filter treated every
    // subsequent block as nested and skipped it.
    const out = stripChrome('<nav>UNCLOSED<footer>CHROME</footer>keep');
    expect(out).not.toContain('CHROME');
    expect(out).toContain('keep');
  });

  it('leaves an unclosed chrome tag untouched', () => {
    const html = '<p>keep</p><nav>unclosed forever';
    expect(stripChrome(html)).toBe(html);
  });

  it('removes a whole nested chrome block rather than leaking its tail', () => {
    // Regression: pairing the outer <nav> with the FIRST </nav> it found
    // ended the removal at the inner block's closer, so everything between
    // that and the real closer survived - i.e. the navigation chrome this
    // pass exists to strip was left in the output.
    expect(stripChrome('<p>keep</p><nav><nav></nav> LEAKED </nav>')).toBe('<p>keep</p>');
  });

  it('removes deeply nested chrome blocks entirely', () => {
    const html = '<p>a</p><nav>1<nav>2<nav>3</nav>4</nav>5</nav><p>b</p>';
    expect(stripChrome(html)).toBe('<p>a</p><p>b</p>');
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

describe('adversarial nesting is bounded', () => {
  it('still strips chrome nested far deeper than any real page', () => {
    expect(stripChrome('<nav>'.repeat(50) + 'MENU' + '</nav>'.repeat(50) + 'keep')).toBe('keep');
  });

  it('leaves input untouched rather than growing the stack without bound', () => {
    // Past the depth ceiling the tag is abandoned, so the text survives
    // verbatim. Degrading to "chrome not stripped" is the safe direction:
    // the alternative is stripping inner blocks whose ancestors are no
    // longer tracked, which could remove real content.
    const hostile = '<nav>'.repeat(1500) + 'MENU' + '</nav>'.repeat(1500) + 'keep';
    expect(stripChrome(hostile)).toBe(hostile);
  });

  it('bounds a stranded opener holding every later block at depth > 0', () => {
    const hostile = '<nav>' + '<nav>y</nav>'.repeat(60_000);
    // Exceeds the buffered-block ceiling, so the input comes back as-is
    // rather than accumulating one record per block.
    expect(stripChrome(hostile)).toBe(hostile);
  });

  it('keeps hostile shapes within a sane time budget', () => {
    const t = performance.now();
    stripChrome('<nav>'.repeat(900_000) + 'x' + '</nav>'.repeat(900_000));
    stripChrome('<nav>x</nav>'.repeat(400_000));
    expect(performance.now() - t).toBeLessThan(5_000);
  });
});

// These run end to end through `htmlToMarkdown`, not just `stripChrome`.
// The earlier caps bounded this file's own scanner but then handed the
// untouched input to Turndown, which parses to a DOM and walks it
// recursively - so the process still died on depth. Asserting on
// `stripChrome` alone could not see that.
describe('nesting depth is bounded end to end', () => {
  const deep = (tag: string, n: number): string =>
    `<${tag}>`.repeat(n) + 'payload' + `</${tag}>`.repeat(n);

  it.each([
    ['nav', 3_000],
    ['div', 3_000],
    ['nav', 100_000],
    ['div', 100_000],
  ])('survives %s nested %i deep, and keeps the text', (tag, n) => {
    const started = Date.now();
    // Previously: RangeError at this depth, reached only after ~113s of
    // synchronous work at 100k. Both are failure modes for a server
    // sharing one event loop across requests.
    expect(htmlToMarkdown(deep(tag as string, n as number))).toBe('payload');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('counts unknown elements, which the HTML parser nests like any other', () => {
    expect(htmlToMarkdown(deep('x-widget', 50_000))).toBe('payload');
  });

  it('reports depth for the shapes that trip it, and not for ordinary ones', () => {
    expect(exceedsNestingDepth(deep('div', 600), 500)).toBe(true);
    expect(exceedsNestingDepth(deep('div', 400), 500)).toBe(false);
    expect(exceedsNestingDepth('<article><p>hi <b>there</b></p></article>', 500)).toBe(false);
  });

  // Optional end tags are legal and common. Counting them naively would
  // make an ordinary table or list look thousands of levels deep and
  // silently downgrade real pages to plain text.
  it.each([
    ['unclosed <li>', `<ul>${'<li>item'.repeat(5_000)}</ul>`],
    ['unclosed <td>/<tr>', `<table>${'<tr><td>cell'.repeat(3_000)}</table>`],
    ['unclosed <p>', '<p>para'.repeat(2_000)],
    ['void <br>', `a${'<br>'.repeat(5_000)}b`],
    ['self-closing', `<div>${'<img src="x"/>'.repeat(5_000)}</div>`],
  ])('does not trip on %s', (_label, html) => {
    expect(exceedsNestingDepth(html as string, 500)).toBe(false);
  });

  it('still converts a normal document through turndown', () => {
    expect(
      htmlToMarkdown('<article><h1>T</h1><p>Hello <b>world</b></p><ul><li>a</li></ul></article>'),
    ).toBe('# T\n\nHello **world**\n\n-   a');
  });
});

describe('htmlToText', () => {
  it('keeps character data, drops markup, and decodes basic entities', () => {
    expect(htmlToText('<div><p>Hello <b>world</b></p></div>')).toBe('Hello world');
    expect(htmlToText('<p>5 &lt; 6 &amp;&nbsp;ok</p>')).toBe('5 < 6 & ok');
  });

  it('does not treat script or style bodies as text', () => {
    expect(htmlToText('<p>keep</p><script>var x = "drop";</script><style>.a{color:red}</style>')).toBe(
      'keep',
    );
  });

  it('treats a bare "<" as text rather than the start of a tag', () => {
    expect(htmlToText('<p>5 < 6</p>')).toBe('5 < 6');
  });

  it('ignores comments and doctype', () => {
    expect(htmlToText('<!doctype html><!-- note --><p>body</p>')).toBe('body');
  });

  it('treats <!--> as a closed comment, not one that runs to EOF', () => {
    expect(htmlToText(`<!-->${'<p>body</p>'}`)).toBe('body');
    expect(htmlToText(`<!--->${'<p>body</p>'}`)).toBe('body');
  });

  // The tag scanner used to stop at the first '>', so everything after a '>'
  // inside a quoted attribute value was re-read as character data.
  it('does not spill attribute values into the text', () => {
    expect(htmlToText('<div title="></div>SECRET">visible</div>')).toBe('visible');
    expect(htmlToText('<p data-x="a > b">text</p>')).toBe('text');
  });

  it('only ends a raw-text element on a real end tag', () => {
    expect(htmlToText('<p>keep</p><script>a</script-x>DROP</script><p>after</p>')).toBe(
      'keep after',
    );
  });

  // Turndown drops these outright, so the fallback has to agree or the two
  // paths would report different page content.
  it.each([
    ['noscript', '<p>keep</p><noscript><p>hidden</p></noscript>'],
    ['iframe', '<p>keep</p><iframe><p>framed</p></iframe>'],
    ['style', '<style>.a{color:red}</style><p>keep</p>'],
  ])('drops %s content the way turndown does', (_label, html) => {
    expect(htmlToText(html as string)).toBe('keep');
  });

  it('keeps text after a "<" that starts no tag', () => {
    // HTML5 needs an ASCII letter after `<`; treating `<2` as a tag name
    // silently dropped everything that followed it.
    expect(htmlToText('a < b and 1<2')).toContain('2');
    expect(htmlToText('<p>1<2 and 3<4</p>')).toContain('4');
  });

  it('stays linear on unmatched closing tags', () => {
    // Previously popped with lastIndexOf, which is O(n^2) when nothing matches.
    const started = Date.now();
    expect(htmlToText(`${'<div>'.repeat(100_000)}x${'</span>'.repeat(100_000)}`)).toBe('x');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('bounds its own output', () => {
    const out = htmlToText('<b>xxxxxxxx</b>'.repeat(600_000));
    expect(out.length).toBeLessThanOrEqual(2_000_000);
  });
});

// Every one of these nests far deeper than the limit, yet an earlier version
// of the scanner reported them as shallow because it tried to reproduce HTML5
// tree construction and guessed low. A guard may over-report depth; guessing
// low is a bypass, and each of these reached turndown and threw RangeError
// after seconds of synchronous work.
describe('render budget bypasses', () => {
  it.each([
    ['self-closing on a non-void element', '<div/>'.repeat(1_500)],
    ['a trailing "/" in an unquoted attribute value', '<div class=x/>'.repeat(1_500)],
    ['">" inside a quoted attribute value', '<div title="></div>">'.repeat(1_500)],
    ["'>' inside a single-quoted attribute value", "<div title='></div>'>".repeat(1_500)],
    ['unquoted attribute holding a quote', '<div x=a">'.repeat(1_500)],
    ['mis-nested formatting elements', '<b><i></b>'.repeat(5_000)],
    ['an end tag blocked by a special element', '<b><div></b>'.repeat(3_000)],
    ['abrupt closing of an empty comment', `<!-->${'<div>'.repeat(1_500)}`],
    ['self-closing abused via foreignObject', `<svg>${'<foreignObject><div/>'.repeat(1_500)}`],
    ['a "/" in an unquoted attribute inside svg', `<svg>${'<g a=b/>'.repeat(1_500)}`],
    ['an html element self-closed inside svg', `<svg>${'<div a=b/>'.repeat(1_500)}`],
    ['a breakout tag self-closed inside svg', `<svg>${'<span a=b/>'.repeat(1_500)}`],
    ['a breakout tag self-closed inside math', `<math>${'<div a=b/>'.repeat(1_500)}`],
    ['svg <title> treated as raw text', `<svg><title>${'<div>'.repeat(1_500)}`],
    ['svg <textarea> treated as raw text', `<svg><textarea>${'<div>'.repeat(1_500)}`],
    ['svg <style> treated as raw text', `<svg><style>${'<div>'.repeat(1_500)}`],
    ['a stray slash between attributes in svg', `<svg>${'<g / >'.repeat(1_500)}`],
    ['an end tag for svg that matches nothing', `<svg><g></svg>${'<g/>'.repeat(1_500)}`],
    ['an end tag for math that matches nothing', `<math><mrow></math>${'<mrow/>'.repeat(1_500)}`],
    ['svg <title> keeping foreign self-closing', `<svg><title>${'<g/>'.repeat(1_500)}`],
    ['raw text re-enabled by an svg breakout', `<svg><font><title>${'<div>'.repeat(1_500)}`],
    ['raw text re-enabled inside math', `<math><annotation-xml><textarea>${'<div>'.repeat(1_500)}`],
    ['a cross-namespace end tag draining the root count', `<svg></math><title>${'<div>'.repeat(1_500)}`],
    ['a nested foreign root closing once', `<svg><svg></svg><title>${'<div>'.repeat(1_500)}`],
    ['optional end tags popping inside svg', `<svg><mi>${'<td>'.repeat(1_500)}`],
    ['optional end tags popping inside math', `<math><mtext>${'<option>'.repeat(1_500)}`],
    ['a void breakout tag inside svg', `<svg><br>${'<g/>'.repeat(1_500)}`],
    ['a void breakout tag inside math', `<math><img>${'<mrow/>'.repeat(1_500)}`],
    ['an element that merely looks void', '<brx>'.repeat(1_500)],
    // HTML5 only applies the foreign end-tag rule while the current node is
    // foreign. Inside an integration point or after a breakout tag the parser
    // is back in HTML and ignores `</svg>` entirely, so honouring it there
    // let each repeat leave a level behind.
    ['</svg> arriving inside foreignObject', '<svg><foreignObject><div></svg>'.repeat(1_000)],
    ['</svg> arriving inside desc', '<svg><desc><b></svg>'.repeat(1_000)],
    ['</svg> arriving inside an svg title', '<svg><title><section></svg>'.repeat(1_000)],
    ['</math> arriving inside mi', '<math><mi><div></math>'.repeat(1_000)],
    ['</math> arriving inside annotation-xml', '<math><annotation-xml><p></math>'.repeat(1_000)],
    ['</svg> arriving after a breakout tag', '<svg><p><div></svg>'.repeat(1_000)],
    ['</svg> arriving after a void breakout tag', '<svg><br><div></svg>'.repeat(1_000)],
    ['sheer width rather than depth', '<b>x</b>'.repeat(200_000)],
  ])('refuses %s', (_label, html) => {
    const started = Date.now();
    expect(exceedsRenderBudget(html as string)).toBe(true);
    expect(() => htmlToMarkdown(html as string)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // Inline SVG is everywhere in documentation. In foreign content a trailing
  // '/' really does self-close, so refusing to honour it there would burn a
  // level per icon and downgrade ordinary pages to plain text. The marker is
  // therefore honoured only where the tokenizer would set it: still inside
  // foreign content, and not part of an unquoted attribute value.
  it.each([
    ['inline svg icons', `<div>${'<svg><circle/><path/></svg>'.repeat(300)}</div>`],
    ['svg with attributes', `<div>${'<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>'.repeat(300)}</div>`],
    ['svg carrying a title', `<div>${'<svg><title>icon</title><path d="M0"/></svg>'.repeat(300)}</div>`],
    ['svg carrying title and desc', `<div>${'<svg><title>i</title><desc>d</desc><path d="M0"/></svg>'.repeat(300)}</div>`],
    ['the sprite pattern', `<div>${'<svg><use href="#i"></svg>'.repeat(300)}</div>`],
    ['icons following a stray end tag', `<div></svg>${'<svg><path d="M0"/></svg>'.repeat(300)}</div>`],
    ['a self-closed svg root', `<div>${'<svg/>'.repeat(300)}</div>`],
    ['mathml', `<div>${'<math><mi>x</mi><mo>+</mo></math>'.repeat(300)}</div>`],
    ['stray closing tags', '<div>a</span></p></b>b</div>'.repeat(500)],
    ['">" inside an attribute on a normal page', '<div title="a > b">ok</div>'.repeat(500)],
    // `</p>` is optional before a block element, so this is 2 levels, not 2400.
    ['paragraphs closed by a block element', '<p>text<div>more</div>'.repeat(1_200)],
    ['paragraphs closed by a heading', '<p>text<h2>head</h2>'.repeat(1_200)],
    // A tag name has to start with an ASCII letter, so these are text.
    ['digits and punctuation after "<"', '1<2 and a<_b and x<-y '.repeat(1_000)],
    // Omitted end tags are legal and minifiers emit them deliberately. A
    // closing tag has to pop past the elements the parser closes implicitly,
    // or an ordinary list grows the stack by two per item: these are all
    // 3-5 levels deep and used to be refused at under 6 KB.
    ['a list omitting </li>', '<ul><li>a<li>b</ul>'.repeat(251)],
    ['a table omitting </td>', '<table><tr><td>a<td>b</tr></table>'.repeat(167)],
    ['a definition list omitting </dt>', '<dl><dt>a<dd>b</dl>'.repeat(300)],
    ['paragraphs omitting </p>', '<div><p>a<p>b</div>'.repeat(600)],
    ['a table with sections omitting end tags', '<table><thead><tr><th>h<tbody><tr><td>d</table>'.repeat(200)],
    ['a select omitting </option>', '<select><optgroup><option>a<option>b</select>'.repeat(300)],
  ])('still renders %s through turndown', (_label, html) => {
    expect(exceedsRenderBudget(html as string)).toBe(false);
  });
});

// The tables above only ever test shapes someone already thought of, and
// every round of this guard's history was a shape nobody had. This searches
// instead: a short random unit of tags - openers, closers and namespace
// transitions alike - repeated far past the limit. The oracle is the parser
// turndown actually uses, so a disagreement is measured against the real tree
// rather than against a second hand-written model.
//
// Only under-estimation is a bug. Guessing too deep costs a page its
// formatting; guessing too shallow hands turndown a document that stalls the
// process for minutes.
describe('render budget differential search', () => {
  const TOKENS = [
    '<svg>', '<math>', '</svg>', '</math>', '<g>', '<g/>', '<mrow>', '<title>',
    '</title>', '<textarea>', '<style>', '<script>', '<font>', '<annotation-xml>',
    '<foreignObject>', '<desc>', '<mtext>', '<mi>', '<div>', '<span>', '<b>',
    '<p>', '<table>', '<template>', '<mglyph>', '<xmp>', '<br>', '<hr>', '<img>',
    '<li>', '<td>', '<tr>', '<ul>', '<i>', '<a>', '<section>', '<path d="M0"/>',
    '</div>', '</p>', '</b>', '</foreignObject>', '</desc>', '</mi>', '</g>',
    '</li>', '</td>', '</ul>', '</table>', '</a>', '</span>',
  ];

  it('never reports a document as safe when the real tree is not', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const domino = require('@mixmark-io/domino') as {
      createDocument: (html: string, force: boolean) => Document;
    };
    const realDepth = (html: string): number => {
      const doc = domino.createDocument(html, true);
      let max = 0;
      const stack: Array<[Node | null, number]> = [[doc.body, 1]];
      while (stack.length > 0) {
        const [node, depth] = stack.pop() as [Node | null, number];
        if (!node) continue;
        if (depth > max) max = depth;
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 1) stack.push([c, depth + 1]);
        }
      }
      return max;
    };

    // Deterministic so a failure is reproducible from the seed alone.
    let seed = 5150;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

    // The *whole* random unit repeats, closers included. An earlier version
    // built a one-shot prefix and then repeated a single fixed token, which
    // structurally cannot grow a stack that a closing tag mishandles - it
    // reported clean while `<svg><foreignObject><div></svg>` was unbounded.
    const missed: string[] = [];
    for (let trial = 0; trial < 400; trial++) {
      let unit = '';
      const unitLength = 2 + Math.floor(rnd() * 5);
      for (let k = 0; k < unitLength; k++) unit += pick(TOKENS);
      const html = unit.repeat(700);
      if (!exceedsRenderBudget(html) && realDepth(html) > 500) missed.push(unit);
    }
    expect(missed).toEqual([]);
  });
});
