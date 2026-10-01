/**
 * lib/net/addressGuard.ts — the one SSRF guard for every outbound request a
 * model or a config can steer (web_extract URLs, mcp_server_url).
 *
 * WHY one module: there were two hand-rolled copies. web_extract's compared
 * IPv4-mapped IPv6 in dotted form only, but `new URL()` normalizes
 * `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so the metadata
 * address passed; `localhost.` (trailing root dot) passed too; and neither
 * copy resolved DNS, so any internal hostname reached internal services.
 * The MCP copy additionally refused public names that merely start with
 * "fc" or "fd" (fcc.gov, fdic.gov).
 *
 * What this does:
 *   - Normalizes the hostname the way the URL parser hands it over
 *     (brackets, case, trailing dots).
 *   - Refuses local names (localhost, *.local, *.internal, *.home.arpa,
 *     metadata names).
 *   - Parses IP literals properly — IPv4 in any form the URL parser accepts,
 *     IPv6 with `::` compression and embedded IPv4 — and refuses loopback,
 *     private, link-local, CGNAT, unique-local, site-local, multicast,
 *     reserved and documentation ranges, including IPv4 hidden inside
 *     IPv4-mapped, IPv4-compatible, NAT64 (64:ff9b::/96) and 6to4 (2002::/16)
 *     addresses.
 *   - `checkHost` resolves a name and refuses it when ANY address it
 *     resolves to is refused.
 *
 * Known limit (stated, not hidden): the check resolves before the request
 * connects, so a DNS server that answers differently the second time
 * (rebinding) can still race it. Pinning the connection to the checked
 * address needs a custom dispatcher; until then, run the server without
 * ambient cloud credentials on the instance metadata path.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];
const LOCAL_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

/** Hostname as `new URL().hostname` gives it → bare, lowercase, no root dot. */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Reason an IPv4 address (four octets) is refused, or null. */
function ipv4Reason(o: number[]): string | null {
  const [a, b, c] = o;
  if (a === 0) return 'unspecified IPv4';
  if (a === 10) return 'private IPv4';
  if (a === 127) return 'loopback IPv4';
  if (a === 169 && b === 254) return 'link-local/metadata IPv4';
  if (a === 172 && b >= 16 && b <= 31) return 'private IPv4';
  if (a === 192 && b === 168) return 'private IPv4';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT IPv4';
  if (a === 192 && b === 0 && c === 0) return 'IETF-reserved IPv4';
  if (a === 192 && b === 0 && c === 2) return 'documentation IPv4';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking IPv4';
  if (a === 198 && b === 51 && c === 100) return 'documentation IPv4';
  if (a === 203 && b === 0 && c === 113) return 'documentation IPv4';
  if (a >= 224 && a <= 239) return 'multicast IPv4';
  if (a >= 240) return 'reserved IPv4';
  return null;
}

function parseIPv4(s: string): number[] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** IPv6 text → 8 hextets, or null. Handles `::` and a trailing dotted IPv4. */
export function parseIPv6(s: string): number[] | null {
  let text = s.split('%')[0];
  let tailV4: number[] | null = null;
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    tailV4 = parseIPv4(text.slice(lastColon + 1));
    if (!tailV4) return null;
    text = `${text.slice(0, lastColon + 1)}${((tailV4[0] << 8) | tailV4[1]).toString(16)}:${((tailV4[2] << 8) | tailV4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function ipv6Reason(h: number[]): string | null {
  const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeroPrefix = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (h.every((x) => x === 0)) return 'unspecified IPv6';
  if (zeroPrefix(7) && h[7] === 1) return 'loopback IPv6';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (zeroPrefix(5) && h[5] === 0xffff) return ipv4Reason(v4From(h[6], h[7])) ?? null;
  if (zeroPrefix(6)) return ipv4Reason(v4From(h[6], h[7])) ?? 'IPv4-compatible IPv6';
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (h[0] === 0x64 && h[1] === 0xff9b) return ipv4Reason(v4From(h[6], h[7])) ?? null;
  // 6to4 2002:AABB:CCDD::/48 embeds an IPv4 address
  if (h[0] === 0x2002) return ipv4Reason(v4From(h[1], h[2])) ?? null;
  if ((h[0] & 0xfe00) === 0xfc00) return 'unique-local IPv6';
  if ((h[0] & 0xffc0) === 0xfe80) return 'link-local IPv6';
  if ((h[0] & 0xffc0) === 0xfec0) return 'site-local IPv6';
  if ((h[0] & 0xff00) === 0xff00) return 'multicast IPv6';
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'documentation IPv6';
  if (h[0] === 0x0100 && zeroPrefix(0) && h[1] === 0 && h[2] === 0 && h[3] === 0) return 'discard IPv6';
  return null;
}

/** Reason an IP address literal is refused, or null when it is public. */
export function addressReason(ip: string): string | null {
  const host = normalizeHostname(ip);
  const family = isIP(host);
  if (family === 4) {
    const o = parseIPv4(host);
    return o ? ipv4Reason(o) : 'malformed IPv4';
  }
  if (family === 6) {
    const h = parseIPv6(host);
    return h ? ipv6Reason(h) : 'malformed IPv6';
  }
  return null;
}

/**
 * Reason a hostname is refused WITHOUT resolving it: local names and
 * non-public IP literals. Null means "not refused yet" — a name still has to
 * pass `checkHost`.
 */
export function blockedHostReason(hostname: string): string | null {
  const host = normalizeHostname(hostname);
  if (!host) return 'empty hostname';
  if (LOCAL_NAMES.has(host) || LOCAL_NAME_SUFFIXES.some((s) => host.endsWith(s))) return 'local hostname';
  if (isIP(host)) return addressReason(host);
  // A bare single label ("intranet", "db") only resolves through a local
  // search domain: it is never a public site.
  if (!host.includes('.')) return 'single-label (local) hostname';
  return null;
}

export type Resolver = (host: string) => Promise<Array<{ address: string }>>;

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });
let activeResolver: Resolver = systemResolver;

/**
 * Replace the DNS resolver `checkHost` uses by default — for tests that stub
 * `fetch` against hosts that do not exist. Pass nothing to restore the
 * system resolver.
 */
export function setHostResolver(resolver?: Resolver): void {
  activeResolver = resolver ?? systemResolver;
}

/**
 * Full check: the literal rules above, then DNS. A name is refused when ANY
 * address it resolves to is refused (an attacker controls which one a
 * client picks). A name that does not resolve is refused too — there is
 * nothing safe to connect to.
 */
export async function checkHost(hostname: string, resolver?: Resolver): Promise<string | null> {
  const literal = blockedHostReason(hostname);
  if (literal) return literal;
  const host = normalizeHostname(hostname);
  if (isIP(host)) return null;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await (resolver ?? activeResolver)(host);
  } catch {
    return 'hostname does not resolve';
  }
  if (addresses.length === 0) return 'hostname does not resolve';
  for (const { address } of addresses) {
    const reason = addressReason(address);
    if (reason) return `resolves to a ${reason} address`;
  }
  return null;
}
