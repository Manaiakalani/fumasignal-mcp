---
"fumasignal-mcp": patch
---

Enforce SSRF protection at connect time and cap HTML parser memory.

**DNS rebinding is now blocked, not just triaged.** Previously the remote source
resolved a hostname, checked the addresses were public, then handed the
*hostname* to `fetch()`. That is two independent DNS queries, so an attacker who
controls the zone can answer the first with a public address and the second with
`127.0.0.1`. This is not a race that has to be won — alternating short-TTL
answers defeat the check deterministically, and after a domain takeover the
"operator configured this URL" assumption no longer holds.

`createGuardedLookup()` moves the check inside undici's `connect.lookup` hook, so
the address that is validated is the exact address the socket connects to. The
whole answer is rejected if any returned address is private, and the guard fails
closed on lookup errors, empty answers, and timeouts. The existing pre-flight
check is kept because it produces far better error messages for the common case
of a genuinely misconfigured URL.

Adds `undici` as a dependency for its `Agent`/`connect.lookup` API, and uses
**undici's own `fetch`** rather than the global one. This detail is load-bearing:
Node's global `fetch` is backed by a separate, internal copy of undici and
validates `init.dispatcher` against its own `Dispatcher` class, so an `Agent`
from the `undici` package is rejected with `UND_ERR_INVALID_ARG` on Node 20 and
22 — which would break every real request, not just the guard. Newer Node happens
to accept it, so this only shows up on the older supported runtimes; there is now
a regression test pinning the pairing. The `fetchImpl` injection seam is
unchanged: when a caller supplies their own `fetchImpl`, no dispatcher is
attached and they keep full control.

**`engines.node` narrows from `>=20` to `>=20.18.1`**, which is undici v7's
floor. Every other dependency still allows `>=18`; this is the only constraint
raising it. The excluded releases (20.0.0–20.18.0) are superseded patch versions
of a Node line that is itself past end-of-life.

**HTML conversion is now bounded.** Pathological markup could grow
`eachTagBlock`'s opener stack and `removeTagBlocks`'s pending buffer without
bound. Depth is capped at 1,000 and buffered blocks at 50,000; past either cap
the input is returned unmodified rather than stripped. Peak heap on an
adversarial nested document: **144 MB → 10 MB** (243 ms → 11 ms).

That bounds this module's own scanner, but on its own it just moved the failure
downstream: the unmodified input still went to Turndown, which parses to a DOM
and walks it recursively, so nesting depth becomes call-stack depth. Roughly
3,000 nested elements throw `RangeError: Maximum call stack size exceeded`
(fewer on runtimes with a smaller stack), and reaching that point is expensive —
20,000 levels block for ~4 s and 100,000 for ~113 s, all of it synchronous, which
stalls every other request the process is serving. A `try/catch` would not help,
since the stall is paid before the throw.

`htmlToMarkdown()` now runs a linear pre-check and refuses to parse anything
nested deeper than 500 levels or holding more than 50,000 elements, falling back
to a plain-text extraction that keeps the page's prose. The same 100,000-level
document now completes in **67 ms**. The element cap closes the other half of
the same problem: 200,000 sibling elements are flat, so they never threaten the
stack, but they still cost ~15 s and ~750 MB to parse — they are now refused in
46 ms.

The pre-check does not reproduce HTML5 tree construction; it approximates it,
and it is *designed* to guess high — though getting that right took several
attempts, and every place an earlier version guessed low was a bypass: `<div/>`
and `<div class=x/>` (HTML
ignores a trailing `/` on non-void elements), `<div title="></div>">` (a `>`
inside a quoted attribute value ended the tag scan early, and the fake closer
then reset the stack), `<b><i></b>` (the adoption agency algorithm re-opens
formatting elements, so the real tree gets *deeper* while a pop-to-match stack
empties) and `<!-->` (an abrupt closing of an empty comment, read as one that
never ends, discarding the rest of the document). Each of these reached
Turndown and threw after seconds of synchronous work. Over-estimating only
costs one page its Markdown formatting; under-estimating is a stalled process,
so the scanner treats a trailing `/` as self-closing only where the tokenizer
would, and adds depth freely while removing it only under narrow conditions.

It counts unknown elements too, since the HTML parser nests `<x-widget>` like
anything else, and it applies HTML5's optional-end-tag rules — both on the
start tags that imply them, including `</p>` before a block element, and on
close tags, which pop past them to reach their own match. Without the second
half, `<ul><li>a<li>b</ul>` grew the stack by two per list and refused an
ordinary minified page at under 5 KB.

Which elements those are is decided by measuring against the parser, not by
reading the spec's "Optional tags" section: that section is authoring
conformance, while tree construction is insertion-mode gated. `<optgroup>`,
`<rt>` and `<rp>` appear there but nest like any other element outside
`<select>` and `<ruby>`, and taking them on trust cost depth 1 for a tree
nested 1,000 deep. Every element either rule can pop is now held against the
real parser by a test. The same gap applies to raw text: "in select" ignores a
`<style>` or `<title>` start tag outright, so the skip that drops a raw-text
element's contents is disabled inside a `<select>` — otherwise it searched for
a `</style>` that never comes and discarded the rest of the document.

Inline `<svg>` and `<math>` are the one place a trailing `/` genuinely does
self-close, and honouring it there is what keeps icon-heavy pages from being
downgraded — 300 icons is ordinary for a docs sidebar, and refusing the marker
outright costs two levels each. That exemption is narrow, because every way of
widening it was a bypass in its own right, each reporting depth 1 or 2 for a
document the parser nests ~3,000 deep:

- The marker is read from the tokenizer's attribute states rather than from
  the character before `>`, so `<g a=b/>` — where the `/` belongs to an
  unquoted value — is not self-closing.
- Foreign content ends at any of HTML5's ~45 breakout start tags and at the
  integration points, `<title>` included, so one `<svg>` cannot exempt what
  follows via `<div a=b/>` or `<span a=b/>`. Five of those breakout tags —
  `<br>`, `<hr>`, `<img>`, `<embed>`, `<meta>` — are also void, so they never
  open an element; the namespace change is applied to the elements already
  open rather than carried by the new one, which is what makes them count.
- A `</svg>` follows HTML5's foreign end-tag rule and pops to the nearest
  foreign match, but only while the current node is itself foreign. That
  precondition is the whole rule: inside an integration point, or after a
  breakout tag has already returned the parser to HTML, `</svg>` hits a
  special element and is ignored. Honouring it unconditionally meant
  `<svg><foreignObject><div></svg>` left a level behind on every repeat —
  56 KB of it spent 19s in Turndown before throwing.
- Which elements are foreign is tracked per open element rather than as a
  single depth, so leaving an HTML island — `</title>` inside `<svg>` —
  restores foreign content instead of losing it for the rest of the document.

Three operations *remove* work rather than adding it: the raw-text skip, which
drops a whole element's contents, and the optional-end-tag rules and the
foreign end-tag rule, which pop. The first two are HTML-only, and both are
therefore gated on a count of open `<svg>`/`<math>` roots that is maintained
symmetrically — incremented at the push, decremented only when that entry is
popped or when a breakout tag returns it to HTML — rather than on the
per-element namespace flag; while that count is non-zero the optional-end-tag
rules are disabled entirely. The third is foreign-only and is gated on the flag
for the current node. The flag is deliberately
cleared on more tags than the spec requires, which is safe for deciding
whether a trailing `/` self-closes because that only ever adds depth, but is
exactly backwards for these. Each was a distinct unbounded bypass:
`<svg><font><title>` followed by any number of `<div>` reported three
elements, escaping the element cap as well as the depth cap, and `<svg><mi>`
followed by `<td>` popped its way back to depth 1. Measured through
`getPage()`, 15 KB of the first threw `RangeError` after 3 s, and 1 MB had not
finished after 7 minutes.

The plain-text fallback is bounded as well, and no longer spills attribute
values into the text, mistakes `</script-x>` for the end of a `<script>`, keeps
`<noscript>`/`<iframe>` bodies that Turndown discards, or degrades
quadratically on unmatched closing tags (100,000 of them: 3 s → 17 ms).

**A refused connection is now logged** with the hostname and the address it
resolved to. undici reports the refusal to the caller as a generic
`fetch failed` with the reason buried in `err.cause`, and nothing unwraps it, so
this log is the only operator-visible signal that a rebinding attempt was
stopped.

Verified behaviour-preserving: 300,000 randomly generated documents and real
pages produce byte-identical output to the previous implementation.

Also documents the one case the guard cannot decide on its own: operator-specific
NAT64 prefixes, which are indistinguishable from public addresses without knowing
the network's configuration and need egress filtering instead.
