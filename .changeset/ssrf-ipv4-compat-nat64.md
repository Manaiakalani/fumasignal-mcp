---
"fumasignal-mcp": patch
---

Harden the SSRF guard against two additional IPv6 spellings that embed a private/internal IPv4 address. Previously only the IPv4-*mapped* form (`::ffff:a.b.c.d`) was recognized, so a hijacked/dangling DNS record (or, in an IPv6-only network fronted by NAT64/DNS64, a synthesized `AAAA` record) resolving to either of these forms could slip an internal address past the check as an "ordinary" public IPv6 address:

- **IPv4-compatible `::/96`** (e.g. `::127.0.0.1`, which Node canonicalizes to `::7f00:1`).
- **NAT64 well-known prefix `64:ff9b::/96`** (RFC 6052; e.g. `64:ff9b::a9fe:a9fe`, the cloud-metadata address `169.254.169.254` — translated back to that internal IPv4 at connect time on a NAT64 gateway).

Both now have their embedded IPv4 validated the same way the mapped form already was, so a private embedded address is blocked while a public one (matching how `::ffff:8.8.8.8` is allowed) still passes.
