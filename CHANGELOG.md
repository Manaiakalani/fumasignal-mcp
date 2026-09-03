# Changelog

## 0.1.7

### Patch Changes

- f95ba5b: Enforce SSRF protection at connect time and cap HTML parser memory.

  **DNS rebinding is now blocked, not just triaged.** Previously the remote source
  resolved a hostname, checked the addresses were public, then handed the
  _hostname_ to `fetch()`. That is two independent DNS queries, so an attacker who
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
  and it is _designed_ to guess high — though getting that right took several
  attempts, and every place an earlier version guessed low was a bypass: `<div/>`
  and `<div class=x/>` (HTML
  ignores a trailing `/` on non-void elements), `<div title="></div>">` (a `>`
  inside a quoted attribute value ended the tag scan early, and the fake closer
  then reset the stack), `<b><i></b>` (the adoption agency algorithm re-opens
  formatting elements, so the real tree gets _deeper_ while a pop-to-match stack
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

  Three operations _remove_ work rather than adding it: the raw-text skip, which
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

## 0.1.6

### Patch Changes

- d223192: Security hardening, correctness fixes, and supply-chain updates from a multi-model audit round.

  **SSRF / network safety**

  - Rewrote IPv6 classification in `net-safety.ts` to compare numeric 16-bit groups instead of matching canonical address text. Prefix matching on the printed form is spelling-dependent, because `new URL()` places the `::` compression run wherever the address's own zero run happens to fall - so `2002:7f00:1::` was caught while the equivalent `2002:7f00::1` was not. Group comparison removes that whole class of bypass.
  - Classify 6to4 (`2002::/16`, RFC 3056) and Teredo (`2001::/32`, RFC 4380) as non-public when the IPv4 address they embed is private. `2002:a9fe:a9fe::` is the cloud metadata endpoint `169.254.169.254`.
  - Reject the NAT64 local-use prefix `64:ff9b:1::/48` wholesale. RFC 6052 permits /32, /40, /48, /56, /64 and /96 embedding layouts and the operator's chosen prefix length is not recoverable from the address alone, so decoding one fixed layout let the others through. `2001::/32` (Teredo) is rejected wholesale for a related reason: it carries both a server and a client IPv4, so decoding only the client left `2001:0:a9fe:a9fe::` - which names the metadata endpoint as its server - looking public.
  - Added `2001:2::/48` (benchmarking, RFC 5180), `100:0:0:1::/64` (dummy prefix, RFC 9780), and `::ffff:0:0:0/96` (IPv4-translated, RFC 2765).
  - Added IPv4 `192.0.0.0/24` (IETF protocol assignments, RFC 6890) and `192.88.99.0/24` (deprecated 6to4 relay anycast).
  - Bound the pre-flight DNS lookup by the fetch timeout. It previously had no deadline of its own - the fetch timeout only starts once `fetch()` is called - so a resolver that accepted a query and never answered stalled the request indefinitely while holding a fetch-semaphore slot, letting a few such requests wedge every concurrency slot.

  **Parsing correctness**

  - `html-to-md.ts` now tracks tag nesting when locating and removing tag blocks, and selects blocks to remove by span overlap rather than by nesting depth. Pairing each opener with the first following closer truncated nested content (`<article>1<article>2</article>3</article>` lost `3`) and leaked inner content when stripping nav chrome. Tag names are also matched properly now: the old word-boundary pattern treated `<nav-bar>` as an opening `<nav>`, and since `</nav-bar>` closed nothing, one such custom element silently disabled chrome-stripping for the rest of the page. End tags containing whitespace (`</nav >`, valid HTML5) are recognized. The single-pass O(n) guarantee is preserved.
  - `markdown.ts` now implements CommonMark fence rules: tilde fences, up to three spaces of indentation, and fence length. A blind open/close toggle on triple backticks meant a four-backtick block containing a three-backtick line flipped state early and exposed `#` lines inside code as real TOC headings. A backtick fence's info string may not contain backticks, so a line such as ` ` x ` ` stays a paragraph instead of opening a block that nothing closes and swallowing every remaining heading.
  - `extractTitle()` in the remote source now tracks fences too, so a `#` comment inside an opening code block can no longer become the page title.
  - Bounded the memory used while stripping sibling-heavy chrome. Selecting blocks by overlap required knowing each block's extent, and buffering them all meant a hostile page could allocate far more than it occupied: 10 MB of `<nav>x</nav>` produced roughly 873,000 block records and an 88 MB heap spike, multiplied by the fetch concurrency limit. Blocks are now flushed whenever the tag stack empties, since no later block can then become an ancestor of a buffered one. Peak heap for that input drops to about 10 MB with byte-identical output. Uniformly nested pages never empty the stack until the end and so are unchanged; that shape is dominated by the pairing stack itself and would need a depth cap instead.

  **Search**

  - Local search passes original-case tokens to the excerpt builder alongside lowercased ones. JavaScript's `/i` flag does simple rather than full Unicode case folding, so a query like Turkish `İ` scored a page correctly and then failed to locate itself in the body, silently degrading the excerpt to the first 200 characters.
  - Local search breaks score ties by URL. Ordering previously depended on `fs.opendir()` iteration order and so varied across platforms for identical content. Comparison is by code unit rather than `localeCompare()`, whose default collator follows the host locale and would have reintroduced the same variance.
  - Remote search forwards `limit` upstream instead of only slicing the response, which had capped results at the remote's default page size.

  **Supply chain and CI**

  - Resolved all outstanding advisories (`npm audit` now reports zero). Bumped `@modelcontextprotocol/sdk` to `^1.30.0` and pinned transitive `fast-uri` and `postcss` through overrides. The previously proposed `fast-uri` 3.1.4 bump sat inside the advisory's affected range; 3.1.5 is the first fixed release.
  - Narrowed `zod` to `^3.25.0` to match the SDK's own `^3.25 || ^4.0`. The previous `^3.23.8` deduped in this tree, but a consumer install could have resolved two separate `zod` copies and broken the SDK's `instanceof`-based schema handling.
  - Enabled npm provenance. The release workflow already requested `id-token: write`, but nothing turned attestation on, so published artifacts carried none.
  - Added Windows to the CI matrix. This package resolves filesystem paths and compares them against a root prefix, which behaves differently on Windows, and that path was previously untested.
  - Added a CI concurrency group so superseded pull request runs are cancelled.
  - Added `npm audit` to CI. The `brace-expansion` overrides were removed once they proved to be no-ops that made `npm ls` exit non-zero, which leaves the lockfile as the only thing holding transitive packages at patched versions, and nothing in CI would have caught a regression there.
  - Removed the `minimatch`/`brace-expansion` overrides. Their caret ranges already floated to patched releases, so they changed no resolution, but npm applied the child override range to the edge from the top-level `minimatch@10` as well, leaving `npm ls` failing with `ELSPROBLEMS`.
  - Added coverage for the startup failure path in `index.ts`.

## 0.1.5

### Patch Changes

- b81826c: Close remaining CLI validation gaps and small resilience fixes found during a fit-and-finish audit:

  - Reject excess positional CLI arguments instead of silently ignoring them.
  - Enforce mode-appropriate flags: `--search-path`/`--auth-header` (remote-only) now conflict with `--local`; `--content-dir` (local-only) now conflicts with `--url`.
  - Make `--cache-ttl` apply to both remote and local modes; local mode's in-memory index is now rebuilt on a TTL instead of being cached forever.
  - Security fix: validate `--url` after parsing instead of via Commander's `argParser`, so Commander's own error wrapper can no longer re-leak a raw credentialed URL that the inner validator had already redacted.
  - Trim string inputs before length validation across all MCP tool schemas.
  - Surface a truncation notice when a document's heading list is capped instead of truncating silently.
  - CI now runs the full `check` script (typecheck + lint + test + build) before publishing a release, not just `build`.

## 0.1.4

### Patch Changes

- 1dc3def: Harden the SSRF guard against a third IPv6 spelling that embeds a private/internal IPv4 address: the NAT64 **local-use** translation prefix `64:ff9b:1::/48` (RFC 8215), an operator-assigned alternative to the well-known prefix `64:ff9b::/96` already handled. As with the well-known prefix, a hijacked/dangling DNS record (or a synthesized `AAAA` record on an IPv6-only network fronted by a NAT64 gateway configured to use this local-use prefix) resolving to this range could otherwise slip an internal address past the check as an "ordinary" public IPv6 address. The embedded IPv4 is now validated the same way for this prefix as for the others.

## 0.1.3

### Patch Changes

- 55e0492: Harden the SSRF guard against two additional IPv6 spellings that embed a private/internal IPv4 address. Previously only the IPv4-_mapped_ form (`::ffff:a.b.c.d`) was recognized, so a hijacked/dangling DNS record (or, in an IPv6-only network fronted by NAT64/DNS64, a synthesized `AAAA` record) resolving to either of these forms could slip an internal address past the check as an "ordinary" public IPv6 address:

  - **IPv4-compatible `::/96`** (e.g. `::127.0.0.1`, which Node canonicalizes to `::7f00:1`).
  - **NAT64 well-known prefix `64:ff9b::/96`** (RFC 6052; e.g. `64:ff9b::a9fe:a9fe`, the cloud-metadata address `169.254.169.254` — translated back to that internal IPv4 at connect time on a NAT64 gateway).

  Both now have their embedded IPv4 validated the same way the mapped form already was, so a private embedded address is blocked while a public one (matching how `::ffff:8.8.8.8` is allowed) still passes.

## 0.1.2

### Patch Changes

- 002b0b9: Fit-and-finish pass covering CLI correctness, error handling, and packaging hygiene:

  - `--url` now validates that the value is an origin only (scheme + host, no path/query/hash) and fails fast with an actionable message, instead of silently discarding a path per WHATWG `URL` resolution semantics.
  - Tool errors (`search_docs`, `list_pages`, `get_page`, `get_section`, `get_toc`, `get_meta`, `get_llms_txt`) now log a structured `tool` field for easier debugging.
  - Local-mode `get_llms_txt` now correctly distinguishes "genuinely absent" (returns `null`) from "present but unreadable/oversized/symlink-escaped" (throws), matching remote-mode behavior. This also fixes a case where a symlink escaping the project root was silently indistinguishable from a missing file.
  - Remote-mode `search_docs` now wraps malformed JSON responses in a clear `SourceError` instead of an unhandled `SyntaxError`.
  - Fixed a version-drift bug where `--version` and the MCP server's reported version could disagree with `package.json`; both now import a single source of truth.
  - Disabled source maps in the published build (`tsup.config.ts`) and synced `package-lock.json`; the release workflow now keeps the lockfile in sync automatically going forward.
  - `get_meta` output is now wrapped in a fenced code block for readability; several tool descriptions and error messages were reworded for accuracy (`list_pages` limit, `get_page` truncation notice, `get_llms_txt` behavior).
  - Documentation overhaul: split the Claude Desktop / Claude Code quick-start into two correct, verified sections, fixed the Continue.dev config example, corrected the `--auth-header` example to recommend the `FUMASIGNAL_AUTH_HEADER` env var, documented all `FUMASIGNAL_*` env vars, and fixed the `npm run inspector` examples to forward `--url`/`--local`.

  No breaking changes to the MCP tool interface.

## 0.1.1

### Patch Changes

- 2097d4c: Catch-up release covering the extensive security and correctness hardening applied since the 0.1.0 initial release, including: SSRF protections (private/loopback/link-local/RFC 5737 & 3849 documentation-range blocking, DNS-rebinding guards, DNS-failure fail-closed behavior), path-traversal and symlink-escape fixes, ReDoS elimination in markdown/sitemap parsing, resource-exhaustion bounds (heading-index memory, local file size, sitemap byte accumulation, MCP tool output size, concurrent fetch limits), credential redaction in logs and cached auth headers, YAML-bomb and prototype-pollution guards in frontmatter parsing, IPv6 canonicalization fixes, and numerous edge-case corrections found across repeated multi-model security audits. No public API or MCP tool-interface changes.

## 0.1.0 — Initial release

- Remote mode: search via Fumadocs Orama API, list via sitemap, fetch pages via `.md`/`.mdx`/`/raw` or HTML→Markdown fallback, fetch `llms.txt`.
- Local mode: filesystem walk of `content/docs/**/*.{md,mdx}` with gray-matter frontmatter parsing and heading-weighted in-memory search.
- Seven MCP tools: `search_docs`, `list_pages`, `get_page`, `get_section`, `get_toc`, `get_meta`, `get_llms_txt`.
- STDIO transport, single-binary `npx -y fumasignal-mcp` install.
