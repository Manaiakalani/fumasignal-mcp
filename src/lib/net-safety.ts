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
 * The policy: reject if *any* returned address is
 * private/loopback/link-local/otherwise non-public - unless the hostname
 * itself is a literal reference to the local machine (an IP literal, or the
 * name "localhost"), which is treated as explicit operator intent (e.g.
 * testing against a local dev server) rather than an attack.
 *
 * That policy is enforced in two places, and the distinction matters:
 *
 *   - {@link createGuardedLookup} is the *enforcement* point. It runs inside
 *     the connector, so the address it approves is the address the socket
 *     connects to.
 *   - {@link assertPublicResolution} is a *pre-flight* check. It runs before
 *     any socket is opened and produces a far better error message, but it
 *     resolves independently of the connection and so cannot be relied on
 *     alone.
 *
 * Earlier revisions shipped only the pre-flight check and documented the
 * resulting TOCTOU as an accepted risk, on the reasoning that the base URL
 * is operator-supplied configuration rather than attacker-supplied input.
 * That reasoning does not survive contact with the very threat named at the
 * top of this comment: a hijacked or claimed-dangling record means the
 * attacker holds authority over a domain the operator already configured,
 * so "the operator chose this host" stops being a mitigation at exactly the
 * moment the guard is needed. And the gap was never a microsecond race to
 * be won - validation and connection issue two separate queries, and
 * whoever controls the zone answers both, so alternating responses defeat a
 * lookup-only check deterministically. Verified: with connect-time
 * validation removed, a resolver returning a public address to the check
 * and loopback to the connection reads local content; with it in place the
 * connection is refused.
 *
 * Both checks share one resolution seam (`DnsLookupFn`) so they cannot
 * disagree about policy, and both fail closed - an unparseable, empty, or
 * failed answer is treated as unsafe rather than assumed harmless.
 *
 * Remaining limitation worth stating: an operator-specific NAT64 prefix
 * (RFC 6052 network-specific prefixes, as opposed to the well-known
 * `64:ff9b::/96` and `64:ff9b:1::/48` handled below) is ordinary global
 * IPv6 space whose low bits embed an IPv4 address. Such a prefix is
 * indistinguishable from a normal public address without knowing the
 * deployment's configuration, so on a NAT64 network it can reach internal
 * IPv4 space. Closing that requires operator-supplied prefixes or egress
 * filtering; it is not something this module can infer.
 */
import net from 'node:net';
import dns from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';

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
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments (RFC 6890)
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 192.88.99.0/24 6to4 relay anycast (RFC 7526, deprecated)
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Convert two 16-bit groups holding an embedded 32-bit IPv4 address (e.g.
 * 0x7f00 + 0x0001 from "::ffff:7f00:1") into dotted-quad IPv4 notation
 * ("127.0.0.1"). Shared by every embedded-IPv4 form recognized in
 * `isPrivateIPv6()` (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo).
 */
function ipv4FromGroups(hi: number, lo: number): string {
  // Each 16-bit group holds 2 bytes of the embedded IPv4 address.
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Expand a canonical IPv6 literal into its eight numeric 16-bit groups,
 * or `null` if it can't be read as exactly eight.
 *
 * Every check in `isPrivateIPv6()` used to be a *string* match against the
 * canonical text (a `startsWith`, or a regex anchored on literal groups).
 * That silently depends on where the canonical serialization happens to
 * place its "::" run, which varies with the address's own zero runs - so a
 * prefix test written against one spelling misses an address in the same
 * range spelled with a different zero run. Concretely: a regex like
 * `/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/` reads the 6to4 embedded IPv4
 * out of "2002:7f00:1::" correctly, but fails outright on "2002:7f00::1"
 * (127.0.0.0, same range) because the second group got swallowed by the
 * "::". Comparing numeric groups by index has no such blind spot - group
 * N is group N regardless of how the text compressed it - so every range
 * below is tested as an actual bit-prefix rather than as a spelling.
 */
function ipv6Groups(canonical: string): number[] | null {
  const halves = canonical.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parseGroups(halves[0]!);
  const tail = halves.length === 2 ? parseGroups(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...(new Array<number>(fill).fill(0)), ...tail];
  if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n))) return null;
  return groups;
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
  const g = ipv6Groups(canonical);
  if (g === null) return true; // can't decompose it into 8 groups - fail closed rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const topSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // Several IPv6 ranges embed a 32-bit IPv4 address, so an internal IPv4
  // (loopback, 169.254.169.254 metadata, RFC 1918, ...) can be named
  // indirectly by spelling it inside one of them. Each is decoded and its
  // embedded IPv4 validated with the same rules a bare IPv4 would get, so
  // a private embedded address is blocked while a public one still passes
  // (matching how ::ffff:8.8.8.8 is allowed). All are reachable within
  // this file's stated threat model: a hijacked/dangling DNS record can
  // resolve to any of these spellings directly, and in an IPv6-only
  // network fronted by NAT64/DNS64 (increasingly common in cloud
  // environments) a synthesized AAAA for an internal IPv4-only name lands
  // in whichever translation prefix the local gateway uses and is
  // translated back to that internal IPv4 at connect time.
  if (topSixZero && g5 === 0xffff) return isPrivateIPv4(ipv4FromGroups(g6, g7)); // ::ffff:0:0/96 IPv4-mapped
  // ::ffff:0:0:0/96 IPv4-translated (RFC 2765/SIIT). Note the extra zero
  // group: the embedded IPv4 sits in g6:g7 here too, but g4 is 0xffff
  // rather than g5, so the mapped-address arm above (which requires
  // g4 === 0) never saw it and "::ffff:0:a9fe:a9fe" was allowed through.
  // Deprecated by RFC 6145 and not realistically routable, but it costs
  // one comparison to keep the "not globally reachable" coverage complete.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isPrivateIPv4(ipv4FromGroups(g6, g7));
  }
  // ::/96 IPv4-compatible (deprecated by RFC 4291; its only assigned
  // addresses, "::" and "::1", are handled above, so no legitimate public
  // global-unicast address canonicalizes into this range).
  if (topSixZero && g5 === 0) return isPrivateIPv4(ipv4FromGroups(g6, g7));
  // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052) - reserved solely for
  // translation, never allocated for ordinary public unicast.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(ipv4FromGroups(g6, g7));
  }
  // 64:ff9b:1::/48 NAT64 local-use prefix (RFC 8215), rejected wholesale
  // rather than decoded. Inside this /48 an operator picks their own
  // translation prefix at any of the RFC 6052 lengths (/32, /40, /48,
  // /56, /64 or /96), and only the /96 layout puts the embedded IPv4 in
  // the low 32 bits. This used to decode just that one layout, which
  // misreads all the others - e.g. "64:ff9b:1:0:a:0:100:0" carries
  // 10.0.0.1 under a /64-style layout but was classified off its trailing
  // groups as the public 1.0.0.0 and allowed through. The chosen prefix
  // length isn't recoverable from the address alone, so several layouts
  // are genuinely ambiguous and no amount of decoding can disambiguate
  // them; since the whole /48 is reserved exclusively for NAT64 and never
  // allocated for public unicast, rejecting all of it loses nothing real.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
  // 2002::/16 6to4 (RFC 3056) embeds the IPv4 address in bits 16-47, so
  // "2002:7f00:1::" is 6to4 for 127.0.0.1 and "2002:a9fe:a9fe::" is the
  // 169.254.169.254 metadata endpoint. A host with 6to4 configured
  // encapsulates and delivers such traffic to that IPv4, exactly like the
  // NAT64 case above.
  if (g0 === 0x2002) return isPrivateIPv4(ipv4FromGroups(g1, g2));
  // 2001::/32 Teredo (RFC 4380), rejected wholesale rather than decoded.
  // A Teredo address carries *two* IPv4 addresses: the server's in bits
  // 32-63 (g2:g3) and the client's in bits 96-127 (g6:g7), the latter
  // obfuscated by XOR with all-ones. Decoding only the client field left
  // the server field unchecked, so e.g. "2001:0:a9fe:a9fe::f7f7:f7f7"
  // names the 169.254.169.254 metadata endpoint as its server while
  // presenting a public client address, and was allowed through. Rather
  // than decode both, reject the range outright: all of 2001::/32 is IANA
  // special-purpose and is never ordinary global unicast, so nothing
  // legitimate is lost - the same reasoning already applied to the NAT64
  // local-use prefix above.
  if (g0 === 0x2001 && g1 === 0) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated by RFC 3879, but still a syntactically valid, potentially-still-configured non-public range - a DNS-rebinding attacker controls the *resolved address*, not whether a target network happens to still use it)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only (RFC 6666)
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 1) return true; // 100:0:0:1::/64 dummy prefix (RFC 9780) - non-global by definition, so a resolver handing it back is never a legitimate docs host
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation (RFC 3849)
  if (g0 === 0x2001 && g1 === 0x0002 && g2 === 0) return true; // 2001:2::/48 benchmarking (RFC 5180)
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true; // 2001:10::/28 ORCHID (RFC 4843, deprecated)
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0020) return true; // 2001:20::/28 ORCHIDv2 (RFC 7343)
  if ((g0 & 0xfff0) === 0x3ff0) return true; // 3fff::/20 documentation (RFC 9637)
  if (g0 === 0x5f00) return true; // 5f00::/16 SRv6 SIDs (RFC 9602)
  return false;
}

/**
 * Resolves `hostname` via `lookup` and throws if any resolved address is
 * private/reserved, unless `hostname` is itself a loopback/private IP
 * literal or the name "localhost" (no DNS trust boundary to rebind in
 * that case - the operator directly named the local machine).
 */
/**
 * Bound how long we wait on a DNS answer.
 *
 * The caller's fetch timeout only starts once `fetch()` is invoked, so
 * without this the pre-flight lookup is unbounded: a hostile or merely
 * broken resolver that accepts the query and then never answers stalls the
 * request forever *and* holds its slot in the fetch semaphore, so a handful
 * of such requests can wedge every concurrency slot and stall the whole
 * server. That is a denial-of-service reachable by anyone who controls DNS
 * for the configured host - the same adversary this module already assumes.
 *
 * `lookup()` takes no abort signal (it is a plain `hostname => addresses`
 * seam so tests can inject one), so the underlying query cannot actually be
 * cancelled; Node's own resolver will eventually time out and settle it.
 * What this does is stop *waiting*, which is what frees the semaphore slot.
 * The rejection is deliberately shaped like any other lookup failure so the
 * caller's existing fail-closed path handles it unchanged.
 */
async function withDnsTimeout(
  pending: Promise<ResolvedAddress[]>,
  timeoutMs: number | undefined,
  hostname: string,
): Promise<ResolvedAddress[]> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return pending;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`DNS lookup for "${hostname}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        // Don't let a pending timer hold the process open on its own.
        timer.unref?.();
      }),
    ]);
  } finally {
    // Always clear, including on the success path - otherwise a fast
    // lookup still leaves a live timer per request.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function assertPublicResolution(
  hostname: string,
  lookup: DnsLookupFn,
  timeoutMs?: number,
): Promise<void> {
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
    resolved = await withDnsTimeout(lookup(hostname), timeoutMs, hostname);
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

/** Shape of the `lookup` hook undici's connector accepts (Node's `dns.lookup`). */
export type ConnectLookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * Builds the `connect.lookup` hook that actually *enforces* this module's
 * address policy, for use as `new Agent({ connect: { lookup } })`.
 *
 * This is the answer to the rebinding gap described at the top of this
 * file, and it closes it by construction rather than by narrowing the
 * window. {@link assertPublicResolution} performs its own resolution and
 * then hands the *hostname* to `fetch()`, which resolves independently -
 * so the address that was checked and the address that gets connected to
 * are two different answers to two different queries. Whoever controls
 * the zone chooses both, and a short-TTL record that alternates public
 * and private answers defeats the check outright: it is not a narrow race
 * that an attacker has to win, it is two questions they get to answer
 * separately.
 *
 * Undici calls this hook while establishing the socket, and connects to
 * exactly the address it returns. Validating here therefore makes the
 * address that was checked and the address that is connected to the same
 * value, with no second query in between. There is no window left to
 * rebind in, so this holds even against an adversary with full authority
 * over the zone - which is the realistic post-takeover case, and exactly
 * the one an "the operator configured this URL" argument does not cover.
 *
 * `assertPublicResolution()` is deliberately kept as a pre-flight check
 * rather than replaced. It runs before any socket is opened and can name
 * the offending address in its error, which is a far better diagnostic
 * for the overwhelmingly common cause (a misconfigured docs host) than a
 * connect-time failure. Enforcement lives here; that one is triage.
 */
export function createGuardedLookup(
  lookup: DnsLookupFn,
  timeoutMs?: number,
  onBlocked?: (hostname: string, address: string) => void,
): ConnectLookupFn {
  return (hostname, options, callback) => {
    // Undici hands us the host from the URL, so an IPv6 literal arrives
    // bracketed for the same reason it does in `assertPublicResolution`.
    const bareHost =
      hostname.length > 2 && hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname;

    // A literal IP never had a DNS step, so there is nothing to rebind;
    // it was already judged by the pre-flight check (and by the URL
    // validation before that). Hand it straight back so loopback dev
    // URLs keep working exactly as they do today.
    if (net.isIP(bareHost) !== 0) {
      const family = net.isIP(bareHost);
      callback(null, options.all === true ? [{ address: bareHost, family }] : bareHost, family);
      return;
    }
    const normalizedHost = hostname.toLowerCase().replace(/\.$/, '');
    if (EXPLICIT_LOOPBACK_HOSTNAMES.has(normalizedHost)) {
      // Same carve-out as the pre-flight check: the operator named the
      // local machine directly, so defer to the system resolver.
      dns.lookup(hostname, options, callback);
      return;
    }

    withDnsTimeout(lookup(hostname), timeoutMs, hostname).then(
      (resolved) => {
        if (resolved.length === 0) {
          callback(
            enoent(`Refusing to connect to "${hostname}": DNS resolution returned no addresses.`),
            '',
          );
          return;
        }
        const unsafe = resolved.find((r) => isPrivateOrReservedAddress(r.address));
        if (unsafe) {
          // Reject the whole answer rather than filtering to the safe
          // subset. A response mixing public and private addresses is
          // already anomalous, and connecting to the "good" one would
          // let a hostile zone keep retrying until a pooled connection
          // happened to land where it wanted.
          onBlocked?.(hostname, unsafe.address);
          callback(
            enoent(
              `Refusing to connect to "${hostname}": it resolves to ${unsafe.address}, a private/internal address. ` +
                'This may indicate DNS rebinding, a hijacked or dangling DNS record, or a misconfigured docs host.',
            ),
            '',
          );
          return;
        }
        const addresses: LookupAddress[] = resolved.map((r) => ({
          address: r.address,
          family: net.isIP(r.address),
        }));
        const first = addresses[0] as LookupAddress;
        callback(null, options.all === true ? addresses : first.address, first.family);
      },
      (err: unknown) => {
        // Fail closed, for the reasons spelled out in
        // `assertPublicResolution`'s catch block.
        callback(
          enoent(
            `Refusing to connect to "${hostname}": DNS resolution failed (${err instanceof Error ? err.message : String(err)}), so it cannot be verified as a public address.`,
          ),
          '',
        );
      },
    );
  };
}

/**
 * Undici surfaces a connector error to the caller wrapped in a generic
 * "fetch failed", keeping only `err.cause`. Giving these a DNS-shaped
 * `code` means the reason still reads correctly there instead of being
 * mistaken for a transport fault.
 */
function enoent(message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = 'ENOTFOUND';
  return err;
}
