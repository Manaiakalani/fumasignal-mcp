---
'fumasignal-mcp': patch
---

Security hardening, correctness fixes, and supply-chain updates from a multi-model audit round.

**SSRF / network safety**

- Rewrote IPv6 classification in `net-safety.ts` to compare numeric 16-bit groups instead of matching canonical address text. Prefix matching on the printed form is spelling-dependent, because `new URL()` places the `::` compression run wherever the address's own zero run happens to fall - so `2002:7f00:1::` was caught while the equivalent `2002:7f00::1` was not. Group comparison removes that whole class of bypass.
- Classify 6to4 (`2002::/16`, RFC 3056) and Teredo (`2001::/32`, RFC 4380) as non-public when the IPv4 address they embed is private. `2002:a9fe:a9fe::` is the cloud metadata endpoint `169.254.169.254`.
- Reject the NAT64 local-use prefix `64:ff9b:1::/48` wholesale. RFC 6052 permits /32, /40, /48, /56, /64 and /96 embedding layouts and the operator's chosen prefix length is not recoverable from the address alone, so decoding one fixed layout let the others through. `2001::/32` (Teredo) is rejected wholesale for a related reason: it carries both a server and a client IPv4, so decoding only the client left `2001:0:a9fe:a9fe::` - which names the metadata endpoint as its server - looking public.
- Added `2001:2::/48` (benchmarking, RFC 5180), `100:0:0:1::/64` (dummy prefix, RFC 9780), and `::ffff:0:0:0/96` (IPv4-translated, RFC 2765).
- Added IPv4 `192.0.0.0/24` (IETF protocol assignments, RFC 6890) and `192.88.99.0/24` (deprecated 6to4 relay anycast).
- Bound the pre-flight DNS lookup by the fetch timeout. It previously had no deadline of its own - the fetch timeout only starts once `fetch()` is called - so a resolver that accepted a query and never answered stalled the request indefinitely while holding a fetch-semaphore slot, letting a few such requests wedge every concurrency slot.

**Parsing correctness**

- `html-to-md.ts` now tracks tag nesting when locating and removing tag blocks, and selects blocks to remove by span overlap rather than by nesting depth. Pairing each opener with the first following closer truncated nested content (`<article>1<article>2</article>3</article>` lost `3`) and leaked inner content when stripping nav chrome. Tag names are also matched properly now: the old word-boundary pattern treated `<nav-bar>` as an opening `<nav>`, and since `</nav-bar>` closed nothing, one such custom element silently disabled chrome-stripping for the rest of the page. End tags containing whitespace (`</nav >`, valid HTML5) are recognized. The single-pass O(n) guarantee is preserved.
- `markdown.ts` now implements CommonMark fence rules: tilde fences, up to three spaces of indentation, and fence length. A blind open/close toggle on triple backticks meant a four-backtick block containing a three-backtick line flipped state early and exposed `#` lines inside code as real TOC headings. A backtick fence's info string may not contain backticks, so a line such as ``` ``` x ``` ``` stays a paragraph instead of opening a block that nothing closes and swallowing every remaining heading.
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
