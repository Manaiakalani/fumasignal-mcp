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

The pre-check deliberately *over*-estimates depth instead of reproducing HTML5
tree construction, because every place an earlier version guessed low was a
bypass: `<div/>` and `<div class=x/>` (HTML ignores a trailing `/` on non-void
elements), `<div title="></div>">` (a `>` inside a quoted attribute value ended
the tag scan early, and the fake closer then reset the stack), `<b><i></b>` (the
adoption agency algorithm re-opens formatting elements, so the real tree gets
*deeper* while a pop-to-match stack empties) and `<!-->` (an abrupt closing of
an empty comment, read as one that never ends, discarding the rest of the
document). Each of these reached Turndown and threw after seconds of
synchronous work. Over-estimating only costs one page its Markdown formatting;
under-estimating is a stalled process, so the scanner pops only an exact
innermost match and treats a trailing `/` as self-closing only where the
tokenizer would.

It counts unknown elements too, since the HTML parser nests `<x-widget>` like
anything else, and it applies HTML5's optional-end-tag rules — including `</p>`
before a block element — so ordinary markup that omits `</li>`, `</td>` or
`</p>` is not mistaken for deep nesting.

Inline `<svg>` and `<math>` are the one place a trailing `/` genuinely does
self-close, and honouring it there is what keeps icon-heavy pages from being
downgraded. That exemption is narrow, because each way of widening it was a
bypass in its own right: the marker is read from the tokenizer's attribute
states rather than from the character before `>` (so `<g a=b/>`, where the `/`
belongs to an unquoted value, is *not* self-closing), foreign content ends at
any of HTML5's ~45 breakout tags (so one `<svg>` cannot exempt the rest of the
document via `<div a=b/>` or `<span a=b/>`), and the raw-text rule for
`<title>`, `<style>` and `<textarea>` is suppressed inside foreign content,
where those are ordinary containers that really do nest. Each shape above
reported depth 1 for a document domino parses at ~3,000, and the last escaped
the element cap as well; measured through `getPage()`, 1 MB of it blocked for
8.8 minutes.

Residual imprecision is bounded rather than eliminated: against domino as the
oracle, the scanner under-counts by at most a single-digit number of levels,
and that gap does not grow with document size — it stays under 10 as inputs
scale 256×, against a limit of 500.

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
