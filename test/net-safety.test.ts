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
  });

  it('flags private/reserved IPv6 ranges', () => {
    expect(isPrivateOrReservedAddress('::1')).toBe(true); // loopback
    expect(isPrivateOrReservedAddress('::')).toBe(true); // unspecified
    expect(isPrivateOrReservedAddress('::ffff:127.0.0.1')).toBe(true); // IPv4-mapped loopback
    expect(isPrivateOrReservedAddress('::ffff:10.0.0.1')).toBe(true); // IPv4-mapped private
    expect(isPrivateOrReservedAddress('fe80::1')).toBe(true); // link-local
    expect(isPrivateOrReservedAddress('fc00::1')).toBe(true); // unique local
    expect(isPrivateOrReservedAddress('fd12:3456:789a::1')).toBe(true); // unique local
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

  it('flags loopback/unspecified regardless of which equivalent IPv6 spelling is used', () => {
    expect(isPrivateOrReservedAddress('0:0:0:0:0:0:0:1')).toBe(true); // fully expanded ::1
    expect(isPrivateOrReservedAddress('0:0:0:0:0:0:0:0')).toBe(true); // fully expanded ::
  });

  it('ignores a zone id when classifying a link-local address', () => {
    expect(isPrivateOrReservedAddress('fe80::1%eth0')).toBe(true);
    expect(isPrivateOrReservedAddress('fe80::1%25eth0')).toBe(true); // percent-encoded zone id delimiter
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
});
