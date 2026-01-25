/**
 * SSRF Protection - URL Validator
 * Blocks requests to private IP ranges, localhost, and cloud metadata endpoints
 */

// Private/reserved IP ranges
const BLOCKED_IP_PATTERNS = [
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // 172.16.0.0/12
  /^192\.168\./,                    // 192.168.0.0/16
  /^127\./,                         // 127.0.0.0/8 (loopback)
  /^169\.254\./,                    // 169.254.0.0/16 (link-local/metadata)
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
  /^192\.0\.2\./,                   // TEST-NET-1
  /^198\.51\.100\./,                // TEST-NET-2
  /^203\.0\.113\./,                 // TEST-NET-3
  /^0\./,                           // 0.0.0.0/8
  /^255\.255\.255\.255$/,           // broadcast
];

// Blocked hostnames
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default.svc',
];

// Blocked hostname patterns
const BLOCKED_HOSTNAME_PATTERNS = [
  /^metadata\./i,
  /\.internal$/i,
  /\.local$/i,
  /\.localhost$/i,
];

function isBlockedIp(ip) {
  return BLOCKED_IP_PATTERNS.some(pattern => pattern.test(ip));
}

function isBlockedHostname(hostname) {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(lower)) return true;
  if (BLOCKED_HOSTNAME_PATTERNS.some(p => p.test(lower))) return true;
  return false;
}

function looksLikeIp(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const octets = match.slice(1).map(Number);
    if (octets.every(o => o >= 0 && o <= 255)) return hostname;
  }
  return null;
}

/**
 * Validate a URL for SSRF protection
 * @param {string} url - The URL to validate
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, reason: `Protocol '${parsed.protocol}' not allowed` };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isBlockedHostname(hostname)) {
    return { valid: false, reason: `Hostname '${hostname}' is blocked` };
  }

  const ip = looksLikeIp(hostname);
  if (ip && isBlockedIp(ip)) {
    return { valid: false, reason: `IP '${ip}' is in a blocked range` };
  }

  return { valid: true };
}

/**
 * Validate URL and throw if blocked
 * @param {string} url
 * @throws {Error}
 */
export function assertUrlSafe(url) {
  const result = validateUrl(url);
  if (!result.valid) {
    throw new Error(`SSRF blocked: ${result.reason}`);
  }
}

export default { validateUrl, assertUrlSafe };
