---
"fumasignal-mcp": patch
---

Harden the SSRF guard against a third IPv6 spelling that embeds a private/internal IPv4 address: the NAT64 **local-use** translation prefix `64:ff9b:1::/48` (RFC 8215), an operator-assigned alternative to the well-known prefix `64:ff9b::/96` already handled. As with the well-known prefix, a hijacked/dangling DNS record (or a synthesized `AAAA` record on an IPv6-only network fronted by a NAT64 gateway configured to use this local-use prefix) resolving to this range could otherwise slip an internal address past the check as an "ordinary" public IPv6 address. The embedded IPv4 is now validated the same way for this prefix as for the others.
