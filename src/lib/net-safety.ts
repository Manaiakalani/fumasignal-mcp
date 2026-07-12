/**
 * DNS-rebinding / SSRF-via-hijacked-DNS guard.
 *
 * `RemoteFumadocsSource.fetchSameOrigin()`'s same-origin check compares URL
 * *strings* (protocol+host+port), which says nothing about what IP address
 * the hostname actually resolves to at request time. If the operator's
 * configured hostname's DNS is hijacked, briefly poisoned, or a dangling
 * record gets claimed by an attacker - all realistic, documented attack
 * patterns that don't require compromising the docs site itself - a
 * same-origin-looking request could silently connect to a private or
 * link-local address (including cloud-metadata endpoints like
 * 169.254.169.254) instead, and still carry any configured `Authorization`
 * header.
 *
 * `assertPublicResolution()` resolves a hostname and rejects if *any*
 * returned address is private/loopback/link-local/otherwise non-public -
 * unless the hostname itself is a literal reference to the local machine
 * (an IP literal, or the name "localhost"), which is treated as explicit
 * operator intent (e.g. testing against a local dev server) rather than an
 * attack, and left unchecked.
 *
 * This is a best-effort, per-request check, not a fully airtight
 * DNS-pinning defense: a sufficiently fast attacker who controls
 * authoritative DNS for the target hostname in real time could still
 * theoretically swap the resolved address between this lookup and the
 * connection `fetch()` makes immediately after (classic TOCTOU). Fully
 * closing that would require intercepting the actual low-level connect
 * (a custom dispatcher), which is invasive and disproportionate to this
 * tool's threat model. This check is aimed at the realistic threat - a
 * hijacked, dangling, or misconfigured DNS record persistently pointing at
 * an internal address - not a theoretical microsecond-precision race.
 */
import net from 'node:net';

export interface ResolvedAddress {
  address: string;
}

export type DnsLookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

/** Hostnames always treated as an explicit, intentional local-machine reference. */
const EXPLICIT_LOOPBACK_HOSTNAMES = new Set(['localhost']);

/**
 * True if `ip` (a literal IPv4/IPv6 address) falls within a private,
 * loopback, link-local, or otherwise non-public range. An address that
 * isn't a recognizable literal IP is treated as unsafe rather than
 * silently allowed through.
 */
export function isPrivateOrReservedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared/CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 RFC 2544 benchmark testing
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  // IPv6 has many equivalent textual spellings of the same address
  // (fully-expanded vs. "::"-compressed, zero-padded groups, and - for
  // IPv4-mapped addresses specifically - dotted-quad vs. hex for the
  // embedded IPv4 bits, e.g. "::ffff:127.0.0.1" vs "::ffff:7f00:1" vs
  // "0:0:0:0:0:ffff:127.0.0.1" all name the same address). Matching a
  // regex against the raw input would only ever catch whichever single
  // spelling it was written against, letting an equivalent spelling slip
  // through unrecognized. Canonicalize via the WHATWG URL host parser
  // first - Node normalizes every IPv6 literal it accepts into one
  // consistent serialization (compressed, hex groups, never dotted-quad)
  // - so every check below only has to handle one shape. A zone ID (e.g.
  // "fe80::1%eth0") is stripped first since the URL parser doesn't accept
  // a raw "%" in a bracketed host and the zone id itself doesn't change
  // which address range the literal falls in.
  const zoneIdx = ip.indexOf('%');
  const withoutZone = zoneIdx >= 0 ? ip.slice(0, zoneIdx) : ip;
  let canonical: string;
  try {
    canonical = new URL(`http://[${withoutZone}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return true; // not a literal this parser recognizes - treat as unsafe rather than guess
  }
  if (canonical === '::1' || canonical === '::') return true; // loopback / unspecified
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    // Each 16-bit hex group holds 2 bytes of the embedded IPv4 address.
    const embeddedIPv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(embeddedIPv4); // IPv4-mapped - validate the embedded address
  }
  if (/^fe[89ab]/.test(canonical)) return true; // fe80::/10 link-local
  if (/^fe[cdef]/.test(canonical)) return true; // fec0::/10 site-local (deprecated by RFC 3879, but still a syntactically valid, potentially-still-configured non-public range - a DNS-rebinding attacker controls the *resolved address*, not whether a target network happens to still use it)
  if (canonical.startsWith('fc') || canonical.startsWith('fd')) return true; // fc00::/7 unique local
  if (canonical.startsWith('ff')) return true; // ff00::/8 multicast
  if (/^2001:db8:/.test(canonical)) return true; // 2001:db8::/32 documentation range (RFC 3849)
  return false;
}

/**
 * Resolves `hostname` via `lookup` and throws if any resolved address is
 * private/reserved, unless `hostname` is itself a loopback/private IP
 * literal or the name "localhost" (no DNS trust boundary to rebind in
 * that case - the operator directly named the local machine).
 */
export async function assertPublicResolution(hostname: string, lookup: DnsLookupFn): Promise<void> {
  // `URL.hostname` always wraps IPv6 literals in brackets (e.g. "[::1]"
  // for "http://[::1]:PORT"), but `net.isIP()` only recognizes the bare
  // address - strip them first so IPv6 literal local-dev URLs are
  // skipped the same way bracket-free IPv4 literals (e.g. "127.0.0.1")
  // already are. The URL parser only ever produces a bracketed hostname
  // for an address it already validated as IPv6, so this can't be used
  // to smuggle a non-IP string past the check below.
  const bareHost =
    hostname.length > 2 && hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (net.isIP(bareHost) !== 0) return; // literal IP - no DNS resolution step to hijack
  // A single trailing "." marks a fully-qualified domain name and
  // resolves identically to the name without it (e.g. "localhost." is
  // "localhost") - normalize it away so that form is recognized too.
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '');
  if (EXPLICIT_LOOPBACK_HOSTNAMES.has(normalizedHost)) return;
  let resolved: ResolvedAddress[];
  try {
    resolved = await lookup(hostname);
  } catch (err) {
    // Fail closed rather than open. The alternative - assuming a lookup
    // failure here means the subsequent fetch() will also fail to resolve,
    // so there's nothing to validate - relies on this lookup and fetch()'s
    // own internal resolution going through the exact same path with the
    // exact same outcome. That's *usually* true (both typically bottom out
    // in the OS's getaddrinfo()), but a DNS-controlled adversary could
    // engineer a resolver response that fails this explicit lookup (e.g. a
    // malformed/truncated answer this code doesn't know how to parse)
    // while a differently-shaped query from fetch()'s own resolution path
    // still succeeds - failing validation first, then resolving internally
    // for the real request. Treating "we couldn't verify this is safe" as
    // unsafe removes that gap; the cost is that a transient resolver
    // hiccup on an otherwise-legitimate host surfaces as a request failure
    // here instead of from fetch() a moment later, which is an acceptable
    // trade for a tool whose job is fetching untrusted remote content.
    throw new Error(
      `Refusing to connect to "${hostname}": DNS resolution failed (${err instanceof Error ? err.message : String(err)}), so it cannot be verified as a public address.`,
    );
  }
  // A successful lookup that resolves to zero addresses isn't a realistic
  // getaddrinfo() outcome, but `[].find(...)` would return `undefined`
  // either way, and this function's whole stated philosophy (see the throw
  // above) is to fail closed on anything it can't positively verify as
  // public - "no addresses to check" is exactly that, not "nothing unsafe
  // found".
  if (resolved.length === 0) {
    throw new Error(
      `Refusing to connect to "${hostname}": DNS resolution returned no addresses, so it cannot be verified as a public address.`,
    );
  }
  const unsafe = resolved.find((r) => isPrivateOrReservedAddress(r.address));
  if (unsafe) {
    throw new Error(
      `Refusing to connect to "${hostname}": it resolves to ${unsafe.address}, a private/internal address. ` +
        'This may indicate DNS rebinding, a hijacked or dangling DNS record, or a misconfigured docs host.',
    );
  }
}
