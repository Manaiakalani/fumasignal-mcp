import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { RemoteFumadocsSource } from '../src/sources/remote.js';
import { logger } from '../src/lib/logger.js';
import {
  isPrivateOrReservedAddress,
  assertPublicResolution,
  createGuardedLookup,
} from '../src/lib/net-safety.js';

describe('isPrivateOrReservedAddress', () => {
  it('flags private/reserved IPv4 ranges', () => {
    expect(isPrivateOrReservedAddress('10.0.0.1')).toBe(true); // 10.0.0.0/8
    expect(isPrivateOrReservedAddress('127.0.0.1')).toBe(true); // loopback
    expect(isPrivateOrReservedAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateOrReservedAddress('172.16.0.1')).toBe(true); // 172.16.0.0/12 start
    expect(isPrivateOrReservedAddress('172.31.255.255')).toBe(true); // 172.16.0.0/12 end
    expect(isPrivateOrReservedAddress('192.168.1.1')).toBe(true); // 192.168.0.0/16
    expect(isPrivateOrReservedAddress('0.0.0.0')).toBe(true); // "this network"
    expect(isPrivateOrReservedAddress('100.64.0.1')).toBe(true); // CGNAT start
    expect(isPrivateOrReservedAddress('100.127.255.255')).toBe(true); // CGNAT end
    expect(isPrivateOrReservedAddress('224.0.0.1')).toBe(true); // multicast
    expect(isPrivateOrReservedAddress('255.255.255.255')).toBe(true); // reserved
    expect(isPrivateOrReservedAddress('198.18.0.1')).toBe(true); // 198.18.0.0/15 RFC 2544 benchmark start
    expect(isPrivateOrReservedAddress('198.19.255.255')).toBe(true); // 198.18.0.0/15 RFC 2544 benchmark end
    expect(isPrivateOrReservedAddress('192.0.2.1')).toBe(true); // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
    expect(isPrivateOrReservedAddress('198.51.100.1')).toBe(true); // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
    expect(isPrivateOrReservedAddress('203.0.113.1')).toBe(true); // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  });

  it('allows public IPv4 addresses, including just outside private range boundaries', () => {
    expect(isPrivateOrReservedAddress('8.8.8.8')).toBe(false); // Google DNS
    expect(isPrivateOrReservedAddress('1.1.1.1')).toBe(false); // Cloudflare DNS
    expect(isPrivateOrReservedAddress('172.15.255.255')).toBe(false); // just below 172.16/12
    expect(isPrivateOrReservedAddress('172.32.0.0')).toBe(false); // just above 172.16/12
    expect(isPrivateOrReservedAddress('192.167.255.255')).toBe(false); // just below 192.168/16
    expect(isPrivateOrReservedAddress('192.169.0.0')).toBe(false); // just above 192.168/16
    expect(isPrivateOrReservedAddress('100.63.255.255')).toBe(false); // just below CGNAT
    expect(isPrivateOrReservedAddress('100.128.0.0')).toBe(false); // just above CGNAT
    expect(isPrivateOrReservedAddress('223.255.255.255')).toBe(false); // just below multicast
    expect(isPrivateOrReservedAddress('198.17.255.255')).toBe(false); // just below 198.18.0.0/15
    expect(isPrivateOrReservedAddress('198.20.0.0')).toBe(false); // just above 198.18.0.0/15
    expect(isPrivateOrReservedAddress('192.0.1.255')).toBe(false); // just below TEST-NET-1
    expect(isPrivateOrReservedAddress('192.0.3.0')).toBe(false); // just above TEST-NET-1
    expect(isPrivateOrReservedAddress('198.51.99.255')).toBe(false); // just below TEST-NET-2
    expect(isPrivateOrReservedAddress('198.51.101.0')).toBe(false); // just above TEST-NET-2
    expect(isPrivateOrReservedAddress('203.0.112.255')).toBe(false); // just below TEST-NET-3
    expect(isPrivateOrReservedAddress('203.0.114.0')).toBe(false); // just above TEST-NET-3
  });

  it('flags private/reserved IPv6 ranges', () => {
    expect(isPrivateOrReservedAddress('::1')).toBe(true); // loopback
    expect(isPrivateOrReservedAddress('::')).toBe(true); // unspecified
    expect(isPrivateOrReservedAddress('::ffff:127.0.0.1')).toBe(true); // IPv4-mapped loopback
    expect(isPrivateOrReservedAddress('::ffff:10.0.0.1')).toBe(true); // IPv4-mapped private
    expect(isPrivateOrReservedAddress('fe80::1')).toBe(true); // link-local
    expect(isPrivateOrReservedAddress('fc00::1')).toBe(true); // unique local
    expect(isPrivateOrReservedAddress('fd12:3456:789a::1')).toBe(true); // unique local
    expect(isPrivateOrReservedAddress('ff02::1')).toBe(true); // multicast (all-nodes link-local)
    expect(isPrivateOrReservedAddress('ff00::')).toBe(true); // multicast (ff00::/8 start)
    expect(isPrivateOrReservedAddress('2001:db8::1')).toBe(true); // 2001:db8::/32 documentation range (RFC 3849)
  });

  it('allows public IPv6 addresses', () => {
    expect(isPrivateOrReservedAddress('2001:4860:4860::8888')).toBe(false); // Google DNS
    expect(isPrivateOrReservedAddress('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    expect(isPrivateOrReservedAddress('::ffff:8.8.8.8')).toBe(false); // IPv4-mapped public
  });

  it('flags IPv4-mapped private addresses regardless of which equivalent IPv6 spelling is used', () => {
    // Regression: the mapped-address check used to be a regex matching
    // only the mixed dotted-quad spelling ("::ffff:a.b.c.d"). The exact
    // same address can also be spelled with the embedded IPv4 bits in
    // hex, compressed or fully expanded, or with the leading zero groups
    // written out - all of these must resolve to the same verdict as
    // "::ffff:127.0.0.1".
    expect(isPrivateOrReservedAddress('::ffff:7f00:1')).toBe(true); // hex form of ::ffff:127.0.0.1
    expect(isPrivateOrReservedAddress('0:0:0:0:0:ffff:127.0.0.1')).toBe(true); // fully expanded, dotted-quad
    expect(isPrivateOrReservedAddress('0000:0000:0000:0000:0000:ffff:7f00:0001')).toBe(true); // fully expanded, hex, zero-padded
    expect(isPrivateOrReservedAddress('::ffff:a00:1')).toBe(true); // hex form of ::ffff:10.0.0.1
  });

  it('allows public IPv4-mapped addresses spelled in hex form', () => {
    expect(isPrivateOrReservedAddress('::ffff:808:808')).toBe(false); // hex form of ::ffff:8.8.8.8
  });

  it('flags IPv4-compatible (::/96) addresses that embed a private/reserved IPv4', () => {
    // Regression: only the IPv4-*mapped* form (::ffff:a.b.c.d) was
    // recognized; the deprecated IPv4-*compatible* form (::a.b.c.d, which
    // Node canonicalizes to "::hi:lo") embeds the same 32-bit IPv4 in its
    // low bits and slipped past as an "ordinary" public IPv6 address. A
    // hijacked/dangling DNS record can resolve directly to this spelling.
    expect(isPrivateOrReservedAddress('::127.0.0.1')).toBe(true); // -> ::7f00:1 (loopback)
    expect(isPrivateOrReservedAddress('::7f00:1')).toBe(true); // hex form of ::127.0.0.1
    expect(isPrivateOrReservedAddress('::169.254.169.254')).toBe(true); // -> ::a9fe:a9fe (cloud metadata)
    expect(isPrivateOrReservedAddress('::10.0.0.1')).toBe(true); // -> ::a00:1 (RFC 1918)
  });

  it('allows IPv4-compatible (::/96) addresses that embed a public IPv4', () => {
    // Matches how ::ffff:8.8.8.8 (mapped, public) is allowed above - only
    // a *private* embedded address is blocked.
    expect(isPrivateOrReservedAddress('::8.8.8.8')).toBe(false); // -> ::808:808
  });

  it('flags NAT64 (64:ff9b::/96) addresses that embed a private/reserved IPv4', () => {
    // Regression: in an IPv6-only network fronted by NAT64/DNS64, a
    // synthesized AAAA for an internal IPv4-only name lands in the
    // well-known prefix 64:ff9b::/96 (RFC 6052) and is translated back to
    // that internal IPv4 at connect time - a documented SSRF bypass. The
    // embedded IPv4 must be validated the same way as the mapped form.
    expect(isPrivateOrReservedAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254 cloud metadata
    expect(isPrivateOrReservedAddress('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1 loopback
    expect(isPrivateOrReservedAddress('64:ff9b::a00:1')).toBe(true); // 10.0.0.1 RFC 1918
  });

  it('allows NAT64 (64:ff9b::/96) addresses that embed a public IPv4', () => {
    expect(isPrivateOrReservedAddress('64:ff9b::808:808')).toBe(false); // 8.8.8.8
  });

  it('flags NAT64 local-use (64:ff9b:1::/48, RFC 8215) addresses that embed a private/reserved IPv4', () => {
    // Regression: RFC 8215 defines 64:ff9b:1::/48 as an operator-assigned
    // alternative to the well-known prefix (e.g. for sites running NAT64
    // on both sides of a double translation, where reusing the WKP for
    // both would be ambiguous).
    expect(isPrivateOrReservedAddress('64:ff9b:1::a9fe:a9fe')).toBe(true); // 169.254.169.254 cloud metadata
    expect(isPrivateOrReservedAddress('64:ff9b:1::7f00:1')).toBe(true); // 127.0.0.1 loopback
    expect(isPrivateOrReservedAddress('64:ff9b:1:dead:beef:cafe:a00:1')).toBe(true); // 10.0.0.1, non-zero middle
  });

  it('flags the whole NAT64 local-use /48, including addresses whose trailing groups look public', () => {
    // This range is rejected wholesale rather than decoded. Inside the /48
    // an operator picks their own translation prefix at any of the RFC 6052
    // lengths (/32, /40, /48, /56, /64 or /96), and only the /96 layout
    // puts the embedded IPv4 in the low 32 bits. Decoding only that layout
    // (as this used to) misreads every other one: "64:ff9b:1:0:a:0:100:0"
    // carries 10.0.0.1 under a /64-style layout, yet reading its trailing
    // groups yields the public-looking 1.0.0.0 and let it through. The
    // operator's chosen prefix length isn't recoverable from the address
    // alone, so the ambiguity can't be decoded away - and since the entire
    // /48 is reserved exclusively for NAT64 translation and never
    // allocated for ordinary public unicast, rejecting all of it costs
    // nothing real.
    expect(isPrivateOrReservedAddress('64:ff9b:1:0:a:0:100:0')).toBe(true); // 10.0.0.1 under a /64-style layout
    expect(isPrivateOrReservedAddress('64:ff9b:1::808:808')).toBe(true);
    expect(isPrivateOrReservedAddress('64:ff9b:1:dead:beef:cafe:808:808')).toBe(true);
  });

  it('flags 6to4 (2002::/16, RFC 3056) addresses that embed a private/reserved IPv4', () => {
    // 6to4 embeds the IPv4 address in bits 16-47, so a host with 6to4
    // configured encapsulates and delivers this traffic to the embedded
    // IPv4 - the same reachability argument as the NAT64 prefixes.
    // Both the compressed and expanded spellings must be caught: matching
    // the canonical *text* missed "2002:7f00::1", where the third group is
    // swallowed by the "::" run.
    expect(isPrivateOrReservedAddress('2002:a9fe:a9fe::')).toBe(true); // 169.254.169.254 cloud metadata
    expect(isPrivateOrReservedAddress('2002:7f00:1::')).toBe(true); // 127.0.0.1 loopback
    expect(isPrivateOrReservedAddress('2002:7f00::1')).toBe(true); // 127.0.0.0, second group compressed away
    expect(isPrivateOrReservedAddress('2002:a00:1::')).toBe(true); // 10.0.0.1 RFC 1918
  });

  it('allows 6to4 (2002::/16) addresses that embed a public IPv4', () => {
    expect(isPrivateOrReservedAddress('2002:808:808::')).toBe(false); // 8.8.8.8
  });

  it('flags the whole Teredo range (2001::/32, RFC 4380), not just a private client IPv4', () => {
    // Teredo carries TWO IPv4 addresses: the server's in bits 32-63 and
    // the client's, XOR-obfuscated, in bits 96-127. Decoding only the
    // client left the server field unchecked - the second case below names
    // 169.254.169.254 as its server while presenting the public 8.8.8.8 as
    // its client, and was allowed through. All of 2001::/32 is IANA
    // special-purpose and never ordinary global unicast, so the range is
    // now rejected wholesale rather than decoded.
    expect(isPrivateOrReservedAddress('2001:0:4136:e378:8000:63bf:f5ff:fffe')).toBe(true); // client 10.0.0.1
    expect(isPrivateOrReservedAddress('2001:0:4136:e378:8000:63bf:80ff:fffe')).toBe(true); // client 127.0.0.1
    expect(isPrivateOrReservedAddress('2001:0:a9fe:a9fe::f7f7:f7f7')).toBe(true); // server 169.254.169.254
    expect(isPrivateOrReservedAddress('2001:0:7f00:1::f7f7:f7f7')).toBe(true); // server 127.0.0.1
    expect(isPrivateOrReservedAddress('2001:0:4136:e378:8000:63bf:f7f7:f7f7')).toBe(true); // client 8.8.8.8
  });

  it('flags IPv4-translated ::ffff:0:0:0/96 addresses carrying a private IPv4', () => {
    // Note the extra zero group vs. IPv4-mapped ::ffff:0:0/96 - here 0xffff
    // sits in group 4, not group 5, so the mapped-address arm never saw it.
    expect(isPrivateOrReservedAddress('::ffff:0:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateOrReservedAddress('::ffff:0:7f00:1')).toBe(true); // 127.0.0.1
  });

  it('flags additional non-public IPv6 special-purpose ranges', () => {
    expect(isPrivateOrReservedAddress('2001:2::1')).toBe(true); // 2001:2::/48 benchmarking (RFC 5180)
    expect(isPrivateOrReservedAddress('2001:10::1')).toBe(true); // 2001:10::/28 ORCHID (RFC 4843)
    expect(isPrivateOrReservedAddress('2001:20::1')).toBe(true); // 2001:20::/28 ORCHIDv2 (RFC 7343)
    expect(isPrivateOrReservedAddress('100::1')).toBe(true); // 100::/64 discard-only (RFC 6666)
    expect(isPrivateOrReservedAddress('100:0:0:1::1')).toBe(true); // 100:0:0:1::/64 dummy prefix (RFC 9780)
    expect(isPrivateOrReservedAddress('3fff::1')).toBe(true); // 3fff::/20 documentation (RFC 9637)
    expect(isPrivateOrReservedAddress('5f00::1')).toBe(true); // 5f00::/16 SRv6 SIDs (RFC 9602)
  });

  it('still allows ordinary public IPv6 addresses', () => {
    expect(isPrivateOrReservedAddress('2001:4860:4860::8888')).toBe(false); // Google public DNS
    expect(isPrivateOrReservedAddress('2606:4700:4700::1111')).toBe(false); // Cloudflare public DNS
  });

  it('flags loopback/unspecified regardless of which equivalent IPv6 spelling is used', () => {
    expect(isPrivateOrReservedAddress('0:0:0:0:0:0:0:1')).toBe(true); // fully expanded ::1
    expect(isPrivateOrReservedAddress('0:0:0:0:0:0:0:0')).toBe(true); // fully expanded ::
  });

  it('ignores a zone id when classifying a link-local address', () => {
    expect(isPrivateOrReservedAddress('fe80::1%eth0')).toBe(true);
    expect(isPrivateOrReservedAddress('fe80::1%25eth0')).toBe(true); // percent-encoded zone id delimiter
  });

  it('flags the deprecated IPv6 site-local range (fec0::/10)', () => {
    // Regression: fe80::/10 (link-local) was checked, but the adjacent
    // fec0::/10 site-local block - deprecated by RFC 3879 but still
    // syntactically valid and potentially still configured on some
    // networks - was not, leaving a gap a DNS-rebinding attacker could
    // resolve a hostname into.
    expect(isPrivateOrReservedAddress('fec0::1')).toBe(true); // fec0::/10 start
    expect(isPrivateOrReservedAddress('feff::1')).toBe(true); // fec0::/10 end
    expect(isPrivateOrReservedAddress('fedc:ba98::1')).toBe(true); // mid-range
  });

  it('does not misclassify addresses just outside the fe80::/10 and fec0::/10 boundaries', () => {
    expect(isPrivateOrReservedAddress('fe7f:ffff::1')).toBe(false); // just below fe80::/10
    expect(isPrivateOrReservedAddress('ff00::1')).toBe(true); // ff00::/8 multicast, not fe.. anymore - still private via multicast rule
  });

  it('flags the IPv6 documentation range (2001:db8::/32) regardless of spelling, and allows just outside it', () => {
    // RFC 3849 section 4 recommends this range be filtered the same way
    // as other non-public space - see net-safety.ts's comment on this
    // check for why "used only in documentation" doesn't mean "safe to
    // allow": operators can and do misconfigure or repurpose it.
    expect(isPrivateOrReservedAddress('2001:0db8::1')).toBe(true); // un-compressed leading zero, same address
    expect(isPrivateOrReservedAddress('2001:DB8::1')).toBe(true); // uppercase hex
    expect(isPrivateOrReservedAddress('2001:db8:ffff::ffff')).toBe(true); // still within /32
    expect(isPrivateOrReservedAddress('2001:db7:ffff::1')).toBe(false); // just below 2001:db8::/32
    expect(isPrivateOrReservedAddress('2001:db9::1')).toBe(false); // just above 2001:db8::/32
  });

  it('fails closed (treats as unsafe) for anything that is not a recognizable literal IP', () => {
    expect(isPrivateOrReservedAddress('not-an-ip')).toBe(true);
    expect(isPrivateOrReservedAddress('example.com')).toBe(true);
    expect(isPrivateOrReservedAddress('')).toBe(true);
  });
});

describe('assertPublicResolution', () => {
  it('skips resolution entirely for literal IP hostnames, even private ones', async () => {
    const lookup = vi.fn();
    await expect(assertPublicResolution('127.0.0.1', lookup)).resolves.toBeUndefined();
    await expect(assertPublicResolution('192.168.1.1', lookup)).resolves.toBeUndefined();
    await expect(assertPublicResolution('::1', lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('skips resolution for "localhost", case-insensitively', async () => {
    const lookup = vi.fn();
    await expect(assertPublicResolution('localhost', lookup)).resolves.toBeUndefined();
    await expect(assertPublicResolution('LOCALHOST', lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('skips resolution for "localhost." (trailing dot marks a fully-qualified name)', async () => {
    const lookup = vi.fn();
    await expect(assertPublicResolution('localhost.', lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('skips resolution for a bracketed IPv6 literal hostname, as produced by URL.hostname', async () => {
    // Regression: `new URL('http://[::1]:1234/').hostname` is "[::1]"
    // (brackets included), but `net.isIP()` only recognizes the bare
    // address and returns 0 for the bracketed form - without stripping
    // the brackets first, an IPv6 literal local-dev URL would fall
    // through to a real lookup instead of being recognized as a literal
    // IP with no DNS trust boundary to rebind.
    const lookup = vi.fn();
    await expect(assertPublicResolution('[::1]', lookup)).resolves.toBeUndefined();
    await expect(assertPublicResolution('[2001:4860:4860::8888]', lookup)).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('throws when a normal hostname resolves to a private address', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '169.254.169.254' }]);
    await expect(assertPublicResolution('docs.example.com', lookup)).rejects.toThrow(
      /private\/internal address/,
    );
  });

  it('throws when only one of several resolved addresses is private', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue([{ address: '8.8.8.8' }, { address: '10.0.0.5' }, { address: '1.1.1.1' }]);
    await expect(assertPublicResolution('docs.example.com', lookup)).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('does not throw when all resolved addresses are public', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8' }, { address: '1.1.1.1' }]);
    await expect(assertPublicResolution('docs.example.com', lookup)).resolves.toBeUndefined();
  });

  it('gives up on a lookup that never settles, instead of hanging forever', async () => {
    // Regression: the caller's fetch timeout only starts once fetch() is
    // called, so this pre-flight lookup was completely unbounded. A
    // resolver that accepts the query and never answers stalled the
    // request indefinitely while holding its slot in the fetch semaphore -
    // a few of those wedge every concurrency slot and stall the server.
    // Reachable by whoever controls DNS for the configured host, which is
    // exactly the adversary this module already assumes exists.
    const lookup = vi.fn().mockReturnValue(new Promise(() => {}));
    await expect(assertPublicResolution('docs.example.com', lookup, 20)).rejects.toThrow(
      /DNS resolution failed.*timed out after 20ms/s,
    );
  });

  it('still fails closed on a timed-out lookup rather than proceeding unverified', async () => {
    const lookup = vi.fn().mockReturnValue(new Promise(() => {}));
    // The timeout must surface through the same fail-closed path as any
    // other lookup failure - never as a silent pass.
    await expect(assertPublicResolution('docs.example.com', lookup, 20)).rejects.toThrow(
      /cannot be verified as a public address/,
    );
  });

  it('does not time out a lookup that answers within the budget', async () => {
    const lookup = vi
      .fn()
      .mockReturnValue(
        new Promise((resolve) => setTimeout(() => resolve([{ address: '8.8.8.8' }]), 5)),
      );
    await expect(
      assertPublicResolution('docs.example.com', lookup, 5000),
    ).resolves.toBeUndefined();
  });

  it('treats a missing or non-positive timeout as unbounded rather than instantly failing', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8' }]);
    await expect(assertPublicResolution('docs.example.com', lookup)).resolves.toBeUndefined();
    await expect(assertPublicResolution('docs.example.com', lookup, 0)).resolves.toBeUndefined();
    await expect(
      assertPublicResolution('docs.example.com', lookup, Number.NaN),
    ).resolves.toBeUndefined();
  });

  it('fails closed (throws) when the lookup itself fails, rather than letting the request proceed unverified', async () => {
    // Regression: this used to swallow the error and return, on the
    // assumption that a lookup failure means fetch()'s own resolution
    // will also fail moments later - see the catch block's comment in
    // net-safety.ts for why that assumption isn't safe to rely on.
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicResolution('nonexistent.invalid', lookup)).rejects.toThrow(
      /DNS resolution failed/,
    );
  });

  it('fails closed (throws) when the lookup succeeds but resolves to zero addresses', async () => {
    // Regression: `resolved.find(...)` on an empty array returns
    // `undefined`, the same as "no unsafe address found" - so a lookup
    // that resolves to nothing at all used to pass this check and let the
    // request proceed, even though this function's own stated philosophy
    // (see the DNS-failure case above) is to fail closed on anything it
    // can't positively verify as public.
    const lookup = vi.fn().mockResolvedValue([]);
    await expect(assertPublicResolution('docs.example.com', lookup)).rejects.toThrow(
      /no addresses/,
    );
  });
});

describe('createGuardedLookup (connect-time enforcement)', () => {
  const call = (
    lookup: ReturnType<typeof createGuardedLookup>,
    host: string,
    options: Record<string, unknown> = { all: true },
  ) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      lookup(host, options as never, (err, address, family) => resolve({ err, address, family })),
    );

  it('rejects a hostname resolving to a private address', async () => {
    const guarded = createGuardedLookup(async () => [{ address: '169.254.169.254' }]);
    const { err } = await call(guarded, 'docs.example.com');
    expect(err?.message).toMatch(/169\.254\.169\.254.*private\/internal/s);
    expect(err?.code).toBe('ENOTFOUND');
  });

  it('rejects the whole answer when only one address is private', async () => {
    const guarded = createGuardedLookup(async () => [
      { address: '93.184.216.34' },
      { address: '127.0.0.1' },
    ]);
    const { err } = await call(guarded, 'docs.example.com');
    expect(err).toBeTruthy();
    expect(err?.message).toContain('127.0.0.1');
  });

  it('returns public addresses, honouring the all flag', async () => {
    const guarded = createGuardedLookup(async () => [
      { address: '93.184.216.34' },
      { address: '2606:2800:220:1:248:1893:25c8:1946' },
    ]);
    const all = await call(guarded, 'docs.example.com', { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    const one = await call(guarded, 'docs.example.com', { all: false });
    expect(one.err).toBeNull();
    expect(one.address).toBe('93.184.216.34');
    expect(one.family).toBe(4);
  });

  it('passes IP literals straight through without resolving', async () => {
    const lookup = vi.fn(async () => [{ address: '10.0.0.1' }]);
    const guarded = createGuardedLookup(lookup);
    const v4 = await call(guarded, '127.0.0.1');
    expect(v4.err).toBeNull();
    expect(v4.address).toEqual([{ address: '127.0.0.1', family: 4 }]);
    // Bracketed IPv6 literals arrive from the URL parser in that form.
    const v6 = await call(guarded, '[::1]');
    expect(v6.err).toBeNull();
    expect(v6.address).toEqual([{ address: '::1', family: 6 }]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed when resolution fails or returns nothing', async () => {
    const failing = createGuardedLookup(async () => {
      throw new Error('SERVFAIL');
    });
    const failed = await call(failing, 'docs.example.com');
    expect(failed.err?.message).toMatch(/DNS resolution failed \(SERVFAIL\)/);

    const empty = createGuardedLookup(async () => []);
    const none = await call(empty, 'docs.example.com');
    expect(none.err?.message).toMatch(/returned no addresses/);
  });

  it('fails closed when the lookup exceeds its timeout', async () => {
    const guarded = createGuardedLookup(() => new Promise(() => {}), 20);
    const { err } = await call(guarded, 'docs.example.com');
    expect(err?.message).toMatch(/timed out after 20ms/);
  });

  it('reports the blocked address to the callback hook', async () => {
    const onBlocked = vi.fn();
    const guarded = createGuardedLookup(async () => [{ address: '10.1.2.3' }], undefined, onBlocked);
    await call(guarded, 'docs.example.com');
    expect(onBlocked).toHaveBeenCalledWith('docs.example.com', '10.1.2.3');
  });
});

// The regression test that matters: prove the rebinding attack this module
// exists to stop is actually stopped end to end, through a real socket.
// The pre-flight check alone cannot stop it, because validation and
// connection issue two separate queries and the zone owner answers both.
describe('DNS rebinding is closed at connect time', () => {
  it('refuses to connect when the resolver rebinds after validation', async () => {
    const server = http.createServer((_req, res) => res.end('INTERNAL-ONLY'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      // Public on the first (validating) query, loopback on every one after.
      let calls = 0;
      const rebinding = async () => [
        { address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1' },
      ];

      // Pre-flight alone is satisfied - it only ever sees the first answer.
      await expect(assertPublicResolution('docs.example.com', rebinding)).resolves.toBeUndefined();

      const agent = new Agent({ connect: { lookup: createGuardedLookup(rebinding) } });
      try {
        // Assert on the specific cause, not merely that it threw: a bare
        // `.toThrow()` would also be satisfied by an unrelated connect
        // timeout, which is exactly what happens if the guard lets the
        // rebound address through.
        const err = await undiciFetch(`http://docs.example.com:${port}/`, {
          dispatcher: agent,
        }).then(
          () => null,
          (e: Error & { cause?: NodeJS.ErrnoException }) => e,
        );
        expect(err, 'rebound request should have been refused').not.toBeNull();
        expect(err?.cause?.code).toBe('ENOTFOUND');
        expect(err?.cause?.message).toContain('127.0.0.1');
        expect(err?.cause?.message).toContain('private/internal address');
      } finally {
        await agent.close();
      }

      // Control: the same server is reachable when the address is legitimate.
      const honest = new Agent({
        connect: { lookup: createGuardedLookup(async () => [{ address: '127.0.0.1' }]) },
      });
      try {
        const res = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: honest });
        expect(await res.text()).toBe('INTERNAL-ONLY');
      } finally {
        await honest.close();
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // The hook itself is unit-tested above; this covers the *wiring*, which is
  // what actually regressed. `createGuardedLookup` was being constructed
  // without an `onBlocked`, so the single highest-signal security event this
  // module can produce was silently discarded: undici reports the refusal to
  // the caller as a bare `fetch failed` and nothing unwraps `err.cause`.
  it('logs the refusal when a real source is rebound', async () => {
    const server = http.createServer((_req, res) => res.end('INTERNAL-ONLY'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    try {
      let calls = 0;
      const source = new RemoteFumadocsSource({
        baseUrl: `http://docs.example.com:${port}`,
        dnsLookup: async () => [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1' }],
      });
      await expect(source.getPage('/docs/x')).rejects.toThrow();

      const logged = warn.mock.calls.find(
        (args) => typeof args[1] === 'string' && args[1].includes('rebinding'),
      );
      expect(logged, 'a refused connection must leave an operator-visible record').toBeDefined();
      expect(logged?.[0]).toMatchObject({
        hostname: 'docs.example.com',
        address: '127.0.0.1',
      });
    } finally {
      warn.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // Regression guard for a bug CI caught and local runs did not. The
  // dispatcher is only honoured by the undici instance that created it:
  // Node's global `fetch` is backed by a separate, internal copy of undici
  // and validates `init.dispatcher` against its own `Dispatcher` class, so
  // an `Agent` from this package is rejected outright with
  // `UND_ERR_INVALID_ARG` on Node 20 and 22. Newer Node happens to accept
  // it, which is precisely why this needs asserting rather than trusting a
  // passing dev-machine run - regressing to `globalThis.fetch` would break
  // every real request on the oldest supported Node, while looking fine
  // locally.
  it('pairs the dispatcher with undici fetch rather than the global fetch', () => {
    const source = new RemoteFumadocsSource({ baseUrl: 'https://docs.example.com' });
    const internals = source as unknown as { fetchImpl: unknown; dispatcher: unknown };
    expect(internals.dispatcher).toBeInstanceOf(Agent);
    expect(internals.fetchImpl).not.toBe(globalThis.fetch);
    expect(internals.fetchImpl).toBe(undiciFetch);
  });

  it('attaches no dispatcher when the caller injects its own fetchImpl', () => {
    const injected = vi.fn();
    const source = new RemoteFumadocsSource({
      baseUrl: 'https://docs.example.com',
      fetchImpl: injected as unknown as typeof fetch,
    });
    const internals = source as unknown as { fetchImpl: unknown; dispatcher: unknown };
    expect(internals.fetchImpl).toBe(injected);
    expect(internals.dispatcher).toBeUndefined();
  });
});
