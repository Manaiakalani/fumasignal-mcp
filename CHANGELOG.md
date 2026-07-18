# Changelog

All notable changes to this project will be documented in this file.

## 0.1.1

### Patch Changes

- 2097d4c: Catch-up release covering the extensive security and correctness hardening applied since the 0.1.0 initial release, including: SSRF protections (private/loopback/link-local/RFC 5737 & 3849 documentation-range blocking, DNS-rebinding guards, DNS-failure fail-closed behavior), path-traversal and symlink-escape fixes, ReDoS elimination in markdown/sitemap parsing, resource-exhaustion bounds (heading-index memory, local file size, sitemap byte accumulation, MCP tool output size, concurrent fetch limits), credential redaction in logs and cached auth headers, YAML-bomb and prototype-pollution guards in frontmatter parsing, IPv6 canonicalization fixes, and numerous edge-case corrections found across repeated multi-model security audits. No public API or MCP tool-interface changes.

## 0.1.0 — Initial release

- Remote mode: search via Fumadocs Orama API, list via sitemap, fetch pages via `.md`/`.mdx`/`/raw` or HTML→Markdown fallback, fetch `llms.txt`.
- Local mode: filesystem walk of `content/docs/**/*.{md,mdx}` with gray-matter frontmatter parsing and heading-weighted in-memory search.
- Seven MCP tools: `search_docs`, `list_pages`, `get_page`, `get_section`, `get_toc`, `get_meta`, `get_llms_txt`.
- STDIO transport, single-binary `npx -y fumasignal-mcp` install.
