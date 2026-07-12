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
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIPv4(mapped[1]!); // IPv4-mapped - validate the embedded address
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10 link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 unique local
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
  } catch {
    // A lookup failure surfaces naturally as a fetch error moments later;
    // there's no resolved address here to validate either way.
    return;
  }
  const unsafe = resolved.find((r) => isPrivateOrReservedAddress(r.address));
  if (unsafe) {
    throw new Error(
      `Refusing to connect to "${hostname}": it resolves to ${unsafe.address}, a private/internal address. ` +
        'This may indicate DNS rebinding, a hijacked or dangling DNS record, or a misconfigured docs host.',
    );
  }
}
