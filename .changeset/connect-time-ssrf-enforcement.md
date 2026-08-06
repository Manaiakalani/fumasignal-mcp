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

**HTML conversion is now bounded end to end.** Pathological markup could grow
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
nested deeper than 500 levels, falling back to a plain-text extraction that keeps
the page's prose. The same 100,000-level document now completes in **23 ms**. The
check counts unknown elements too, since the HTML parser nests `<x-widget>` like
anything else, and it implements HTML5's optional-end-tag rules so that ordinary
markup which omits `</li>`, `</td>` or `</p>` is not mistaken for deep nesting.

Verified behaviour-preserving: 200,000 randomly generated documents and three
real pages produce byte-identical output to the previous implementation.

Also documents the one case the guard cannot decide on its own: operator-specific
NAT64 prefixes, which are indistinguishable from public addresses without knowing
the network's configuration and need egress filtering instead.
