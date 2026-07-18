---
"fumasignal-mcp": patch
---

Catch-up release covering the extensive security and correctness hardening applied since the 0.1.0 initial release, including: SSRF protections (private/loopback/link-local/RFC 5737 & 3849 documentation-range blocking, DNS-rebinding guards, DNS-failure fail-closed behavior), path-traversal and symlink-escape fixes, ReDoS elimination in markdown/sitemap parsing, resource-exhaustion bounds (heading-index memory, local file size, sitemap byte accumulation, MCP tool output size, concurrent fetch limits), credential redaction in logs and cached auth headers, YAML-bomb and prototype-pollution guards in frontmatter parsing, IPv6 canonicalization fixes, and numerous edge-case corrections found across repeated multi-model security audits. No public API or MCP tool-interface changes.
