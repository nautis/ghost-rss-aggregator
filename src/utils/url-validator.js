/**
 * SSRF Protection — URL Validator
 *
 * Two-layer check:
 *   1. validateUrl(url)         — sync, checks scheme + hostname/IP literal blocklist
 *   2. resolveAndValidate(url)  — async, also resolves DNS and checks every returned address
 *
 * Always call resolveAndValidate before making the actual request. validateUrl alone is
 * vulnerable to DNS rebinding (attacker.com -> 127.0.0.1) and is only useful as a fast
 * pre-check before the async resolve.
 */

import { BlockList, isIPv4, isIPv6 } from "node:net";
import dns from "node:dns/promises";

const blockedV4 = new BlockList();
blockedV4.addSubnet("10.0.0.0", 8, "ipv4");          // RFC1918
blockedV4.addSubnet("172.16.0.0", 12, "ipv4");       // RFC1918
blockedV4.addSubnet("192.168.0.0", 16, "ipv4");      // RFC1918
blockedV4.addSubnet("127.0.0.0", 8, "ipv4");         // loopback
blockedV4.addSubnet("169.254.0.0", 16, "ipv4");      // link-local + AWS/GCP/Azure metadata
blockedV4.addSubnet("100.64.0.0", 10, "ipv4");       // CGNAT
blockedV4.addSubnet("0.0.0.0", 8, "ipv4");           // "this network"
blockedV4.addSubnet("192.0.2.0", 24, "ipv4");        // TEST-NET-1
blockedV4.addSubnet("198.51.100.0", 24, "ipv4");     // TEST-NET-2
blockedV4.addSubnet("203.0.113.0", 24, "ipv4");      // TEST-NET-3
blockedV4.addSubnet("224.0.0.0", 4, "ipv4");         // multicast
blockedV4.addSubnet("240.0.0.0", 4, "ipv4");         // reserved
blockedV4.addAddress("255.255.255.255", "ipv4");     // broadcast

const blockedV6 = new BlockList();
blockedV6.addAddress("::1", "ipv6");                 // loopback
blockedV6.addAddress("::", "ipv6");                  // unspecified
blockedV6.addSubnet("fe80::", 10, "ipv6");           // link-local
blockedV6.addSubnet("fc00::", 7, "ipv6");            // unique-local
blockedV6.addSubnet("2001:db8::", 32, "ipv6");       // documentation
blockedV6.addSubnet("ff00::", 8, "ipv6");            // multicast

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default.svc",
]);

const BLOCKED_HOSTNAME_PATTERNS = [
  /^metadata\./i,
  /\.internal$/i,
  /\.local$/i,
  /\.localhost$/i,
];

function isBlockedHostnameLiteral(hostname) {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  return BLOCKED_HOSTNAME_PATTERNS.some(p => p.test(lower));
}

/**
 * Check an IP literal against blocklists. Handles IPv4-mapped IPv6 by extracting
 * the underlying IPv4 and re-checking — Node's URL parser hands us the compressed
 * hex form (`::ffff:7f00:1`), so we accept both that and the dotted-quad form.
 */
function checkIpLiteral(ip) {
  if (isIPv4(ip)) {
    return blockedV4.check(ip, "ipv4");
  }
  if (!isIPv6(ip)) return false;

  // IPv4-mapped, dotted-quad: ::ffff:127.0.0.1
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted && blockedV4.check(dotted[1], "ipv4")) return true;

  // IPv4-mapped, hex form: ::ffff:7f00:1
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const v4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
    if (blockedV4.check(v4, "ipv4")) return true;
  }

  return blockedV6.check(ip, "ipv6");
}

/**
 * Strip surrounding brackets from an IPv6 hostname. `new URL("http://[::1]/").hostname`
 * returns `[::1]` with brackets included.
 */
function unbracket(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Synchronous validation: scheme + literal hostname/IP blocklist.
 * Does NOT resolve DNS — use resolveAndValidate for that.
 */
export function validateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, reason: `Protocol '${parsed.protocol}' not allowed` };
  }

  const hostname = unbracket(parsed.hostname);
  if (!hostname) {
    return { valid: false, reason: "Empty hostname" };
  }

  if (isBlockedHostnameLiteral(hostname)) {
    return { valid: false, reason: `Hostname '${hostname}' is blocked` };
  }

  if ((isIPv4(hostname) || isIPv6(hostname)) && checkIpLiteral(hostname)) {
    return { valid: false, reason: `IP '${hostname}' is in a blocked range` };
  }

  return { valid: true };
}

/**
 * Full validation: sync checks + DNS resolution. Every address returned by the
 * resolver is checked against the blocklist; if any address is private, the URL
 * is rejected. This closes the DNS-rebinding hole that validateUrl alone leaves.
 *
 * Residual TOCTOU: between this check and the actual fetch, an attacker who
 * controls DNS for the hostname could swap the answer. For pinned-IP fetching,
 * pass the returned `addresses` to curl via --resolve or to undici via a custom
 * lookup function.
 */
export async function resolveAndValidate(url) {
  const sync = validateUrl(url);
  if (!sync.valid) return sync;

  const parsed = new URL(url);
  const hostname = unbracket(parsed.hostname);

  // Literal IP — sync check already validated, no DNS needed.
  if (isIPv4(hostname) || isIPv6(hostname)) {
    return { valid: true, addresses: [{ address: hostname, family: isIPv4(hostname) ? 4 : 6 }] };
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, family: 0 });
  } catch (e) {
    return { valid: false, reason: `DNS resolution failed for '${hostname}': ${e.code || e.message}` };
  }

  if (addresses.length === 0) {
    return { valid: false, reason: `No addresses returned for '${hostname}'` };
  }

  for (const { address } of addresses) {
    if (checkIpLiteral(address)) {
      return {
        valid: false,
        reason: `Hostname '${hostname}' resolves to blocked address ${address}`,
      };
    }
  }

  return { valid: true, addresses };
}

/** Sync assertion — throws if the URL fails the literal check. */
export function assertUrlSafe(url) {
  const result = validateUrl(url);
  if (!result.valid) {
    throw new Error(`SSRF blocked: ${result.reason}`);
  }
}

/** Async assertion — throws if DNS resolves to a blocked address. */
export async function assertResolvedUrlSafe(url) {
  const result = await resolveAndValidate(url);
  if (!result.valid) {
    throw new Error(`SSRF blocked: ${result.reason}`);
  }
  return result.addresses;
}

export default { validateUrl, resolveAndValidate, assertUrlSafe, assertResolvedUrlSafe };
