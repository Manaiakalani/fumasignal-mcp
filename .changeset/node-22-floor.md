---
"fumasignal-mcp": minor
---

**Breaking: Node.js 22.19 or newer is now required.** `engines.node` moves from `>=20.18.1` to `>=22.19.0`, and the bundle now targets `node22`. Node 20 reached end of life in April 2026. The next majors of `commander` (15, needs Node 22.12) and `undici` (8, needs Node 22.19, and crashes at load on older 22.x because it uses zlib's zstd support) set the new floor. If you run fumasignal-mcp on Node 20 or an older Node 22, upgrade Node or pin `fumasignal-mcp@0.1.7`. The package is pre-1.0, so this breaking change ships as a minor release (0.2.0).
