/**
 * The SSRF guard (lib/net/addressGuard.ts). Every case goes through
 * `new URL(...).hostname` first — the earlier guard was tested on strings the
 * URL parser never produces, which is how `[::ffff:169.254.169.254]` (the
 * parser normalizes it to hex) slipped past it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { addressReason, blockedHostReason, checkHost, parseIPv6 } from '../lib/net/addressGuard.ts';
import { assertSafeMcpUrl } from '../lib/tools/mcpToolFactory.ts';

const host = (url: string) => new URL(url).hostname;

test('non-public literals are refused in every encoding the URL parser emits', () => {
  for (const url of [
    'http://[::ffff:169.254.169.254]/',  // normalized to [::ffff:a9fe:a9fe]
    'http://[::ffff:127.0.0.1]/',
    'http://[::127.0.0.1]/',             // IPv4-compatible
    'http://[64:ff9b::a9fe:a9fe]/',      // NAT64 of the metadata address
    'http://[2002:a9fe:a9fe::1]/',       // 6to4 embedding 169.254.169.254
    'http://[febf::1]/',                 // inside fe80::/10, not "fe80" literally
    'http://[fd12::1]/',
    'http://[::]/',
    'http://[::1]/',
    'http://localhost./',                // trailing root dot
    'http://metadata.google.internal./',
    'http://2130706433/',                // decimal 127.0.0.1
    'http://0x7f.1/',                    // hex/short IPv4
    'http://017700000001/',              // octal
    'http://10.0.0.1/',
    'http://100.100.100.200/',           // CGNAT (Alibaba metadata)
    'http://192.168.0.10/',
    'http://224.0.0.1/',
    'http://intranet/',                  // single label
  ]) {
    assert.ok(blockedHostReason(host(url)), `expected ${url} (${host(url)}) to be refused`);
  }
});

test('public hosts and literals pass the literal check', () => {
  for (const url of [
    'https://example.com/',
    'https://fcc.gov/',     // starts with "fc": a name, not a ULA address
    'https://fdic.gov/',
    'http://8.8.8.8/',
    'http://172.32.0.1/',
    'http://[2606:4700::6810:84e5]/',
  ]) {
    assert.strictEqual(blockedHostReason(host(url)), null, `expected ${url} to pass`);
  }
});

test('checkHost refuses a name when ANY resolved address is non-public', async () => {
  const resolver = async (h: string) =>
    h === 'mixed.example' ? [{ address: '93.184.216.34' }, { address: '10.0.0.5' }] : [{ address: '93.184.216.34' }];
  assert.match((await checkHost('mixed.example', resolver)) ?? '', /private IPv4/);
  assert.strictEqual(await checkHost('public.example', resolver), null);
});

test('checkHost refuses names that do not resolve', async () => {
  const resolver = async () => {
    throw new Error('ENOTFOUND');
  };
  assert.match((await checkHost('nowhere.example', resolver)) ?? '', /does not resolve/);
});

test('IPv6 parsing handles compression and embedded IPv4', () => {
  assert.deepStrictEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.deepStrictEqual(parseIPv6('2001:db8::1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  assert.strictEqual(parseIPv6('1::2::3'), null);
  assert.strictEqual(addressReason('2606:4700::6810:84e5'), null);
});

test('the MCP client uses the same guard', async () => {
  await assert.rejects(assertSafeMcpUrl('http://[::ffff:a9fe:a9fe]/sse', {}), /link-local|metadata/);
  await assert.rejects(assertSafeMcpUrl('file:///etc/passwd', {}), /scheme/);
  // The development escape hatch still works.
  const url = await assertSafeMcpUrl('http://localhost:3000/sse', { ALLOW_PRIVATE_MCP: 'true' });
  assert.strictEqual(url.hostname, 'localhost');
});
