# Changelog

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
