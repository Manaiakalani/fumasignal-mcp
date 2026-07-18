import { describe, it, expect, vi } from 'vitest';
import { isPrivateOrReservedAddress, assertPublicResolution } from '../src/lib/net-safety.js';

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
    // both would be ambiguous). An operator picks their own /96 (or other
    // length - only /96, RFC 8215's recommendation, is handled here)
    // within that /48, so the middle groups vary by deployment; only the
    // fixed "64:ff9b:1:" prefix and the trailing embedded-IPv4 groups are
    // guaranteed. Covers both the maximally-compressed ("::" right after
    // the fixed prefix) and fully-expanded-with-non-zero-middle cases.
    expect(isPrivateOrReservedAddress('64:ff9b:1::a9fe:a9fe')).toBe(true); // 169.254.169.254 cloud metadata
    expect(isPrivateOrReservedAddress('64:ff9b:1::7f00:1')).toBe(true); // 127.0.0.1 loopback
    expect(isPrivateOrReservedAddress('64:ff9b:1:dead:beef:cafe:a00:1')).toBe(true); // 10.0.0.1, non-zero middle
  });

  it('allows NAT64 local-use (64:ff9b:1::/48, RFC 8215) addresses that embed a public IPv4', () => {
    expect(isPrivateOrReservedAddress('64:ff9b:1::808:808')).toBe(false); // 8.8.8.8
    expect(isPrivateOrReservedAddress('64:ff9b:1:dead:beef:cafe:808:808')).toBe(false); // 8.8.8.8, non-zero middle
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
