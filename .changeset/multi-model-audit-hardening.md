---
'fumasignal-mcp': patch
---

Security hardening, correctness fixes, and supply-chain updates from a multi-model audit round.

**SSRF / network safety**

- Rewrote IPv6 classification in `net-safety.ts` to compare numeric 16-bit groups instead of matching canonical address text. Prefix matching on the printed form is spelling-dependent, because `new URL()` places the `::` compression run wherever the address's own zero run happens to fall - so `2002:7f00:1::` was caught while the equivalent `2002:7f00::1` was not. Group comparison removes that whole class of bypass.
- Classify 6to4 (`2002::/16`, RFC 3056) and Teredo (`2001::/32`, RFC 4380) as non-public when the IPv4 address they embed is private. `2002:a9fe:a9fe::` is the cloud metadata endpoint `169.254.169.254`.
- Reject the NAT64 local-use prefix `64:ff9b:1::/48` wholesale. RFC 6052 permits /32, /40, /48, /56, /64 and /96 embedding layouts and the operator's chosen prefix length is not recoverable from the address alone, so decoding one fixed layout let the others through.
- Added `2001:2::/48` (benchmarking, RFC 5180) and `100:0:0:1::/64` (dummy prefix, RFC 9780).
- Added IPv4 `192.0.0.0/24` (IETF protocol assignments, RFC 6890) and `192.88.99.0/24` (deprecated 6to4 relay anycast).
- Bound the pre-flight DNS lookup by the fetch timeout. It previously had no deadline of its own - the fetch timeout only starts once `fetch()` is called - so a resolver that accepted a query and never answered stalled the request indefinitely while holding a fetch-semaphore slot, letting a few such requests wedge every concurrency slot.

**Parsing correctness**

- `html-to-md.ts` now tracks tag nesting depth when locating and removing tag blocks. Pairing each opener with the first following closer truncated nested content (`<article>1<article>2</article>3</article>` lost `3`) and leaked inner content when stripping nav chrome. The single-pass O(n) guarantee is preserved.
- `markdown.ts` now implements CommonMark fence rules: tilde fences, up to three spaces of indentation, and fence length. A blind open/close toggle on triple backticks meant a four-backtick block containing a three-backtick line flipped state early and exposed `#` lines inside code as real TOC headings.
- `extractTitle()` in the remote source now tracks fences too, so a `#` comment inside an opening code block can no longer become the page title.

**Search**

- Local search passes original-case tokens to the excerpt builder alongside lowercased ones. JavaScript's `/i` flag does simple rather than full Unicode case folding, so a query like Turkish `İ` scored a page correctly and then failed to locate itself in the body, silently degrading the excerpt to the first 200 characters.
- Local search breaks score ties by URL. Ordering previously depended on `fs.opendir()` iteration order and so varied across platforms for identical content.
- Remote search forwards `limit` upstream instead of only slicing the response, which had capped results at the remote's default page size.

**Supply chain and CI**

- Resolved all outstanding advisories (`npm audit` now reports zero). Bumped `@modelcontextprotocol/sdk` to `^1.30.0` and pinned transitive `fast-uri`, `postcss`, and `brace-expansion` through overrides. The previously proposed `fast-uri` 3.1.4 bump sat inside the advisory's affected range; 3.1.5 is the first fixed release.
- Enabled npm provenance. The release workflow already requested `id-token: write`, but nothing turned attestation on, so published artifacts carried none.
- Added Windows to the CI matrix. This package resolves filesystem paths and compares them against a root prefix, which behaves differently on Windows, and that path was previously untested.
- Added a CI concurrency group so superseded pull request runs are cancelled.
- Added coverage for the startup failure path in `index.ts`.
