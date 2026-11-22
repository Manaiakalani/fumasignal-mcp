---
"fumasignal-mcp": minor
---

**Breaking: Node.js 22.12 or newer is now required.** `engines.node` moves from `>=20.18.1` to `>=22.12.0`, and the bundle now targets `node22`. Node 20 reached end of life in April 2026, and the next majors of `commander` (15) and `undici` (8) require Node 22. If you run fumasignal-mcp on Node 20, upgrade Node or pin `fumasignal-mcp@0.1.7`. The package is pre-1.0, so this breaking change ships as a minor release (0.2.0).
