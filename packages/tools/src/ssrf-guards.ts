/**
 * SSRF protection helpers — shared by web-fetch and browser tools.
 *
 * Blocks requests to private/reserved IP ranges, cloud metadata endpoints,
 * and localhost. DNS resolution is validated before connecting.
 */

import { resolve4, resolve6 } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------

/** Hostnames that must never be reached (cloud metadata services). */
const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',           // AWS / GCP / Azure instance metadata
  'metadata.google.internal',  // GCP metadata alternative
  'metadata.internal',         // Generic cloud metadata
]);

// ---------------------------------------------------------------------------
// IP range checks
// ---------------------------------------------------------------------------

/**
 * Check whether an IPv4 address falls in a private or reserved range.
 *
 * Blocked ranges:
 *   127.0.0.0/8        loopback
 *   10.0.0.0/8         Class A private
 *   172.16.0.0/12      Class B private
 *   192.168.0.0/16     Class C private
 *   169.254.0.0/16     link-local
 *   0.0.0.0/8          "this" network
 *   100.64.0.0/10      shared address space (RFC 6598)
 *   192.0.0.0/24       IANA special purpose
 *   192.0.2.0/24       documentation (TEST-NET-1)
 *   198.51.100.0/24    documentation (TEST-NET-2)
 *   203.0.113.0/24     documentation (TEST-NET-3)
 *   224.0.0.0/4        multicast
 *   240.0.0.0/4        reserved
 */
export function isPrivateIpV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed — treat as blocked.
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return true;                         // 127.0.0.0/8
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10
  if (a === 192 && b === 0) return true;               // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && b === 51) return true;              // 198.51.100.0/24
  if (a === 203 && b === 0) return true;               // 203.0.113.0/24
  if (a >= 224) return true;                           // 224.0.0.0/4 + 240.0.0.0/4

  return false;
}

/**
 * Check whether an IPv6 address is private/reserved.
 *
 * Blocked:  ::1 (loopback), fe80::/10 (link-local), fc00::/7 (ULA),
 *           :: (unspecified), ::ffff:0:0/96 (IPv4-mapped — re-check the v4 part).
 */
export function isPrivateIpV6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true;   // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    return isPrivateIpV4(v4Mapped[1]!);
  }

  return false;
}

/**
 * Synchronous check: does the URL hostname point to a blocked host?
 * Catches IP-literal hostnames and well-known metadata hostnames.
 */
export function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  if (hostname === 'localhost') return true;

  // Direct IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isPrivateIpV4(hostname);
  }

  // IPv6 literal (brackets stripped by URL parser)
  if (hostname.includes(':')) {
    return isPrivateIpV6(hostname);
  }

  return false;
}

/**
 * Async check: resolve the hostname via DNS and verify none of the
 * resolved addresses are private or reserved.
 */
export async function resolveAndCheckPrivate(hostname: string): Promise<{ blocked: boolean; reason?: string }> {
  // Skip DNS resolution for IP literals — already checked synchronously.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    return { blocked: false };
  }

  try {
    const [v4Addrs, v6Addrs] = await Promise.all([
      resolve4(hostname).catch(() => [] as string[]),
      resolve6(hostname).catch(() => [] as string[]),
    ]);

    for (const addr of v4Addrs) {
      if (isPrivateIpV4(addr)) {
        return { blocked: true, reason: `DNS resolved to private IPv4 address ${addr}` };
      }
    }
    for (const addr of v6Addrs) {
      if (isPrivateIpV6(addr)) {
        return { blocked: true, reason: `DNS resolved to private IPv6 address ${addr}` };
      }
    }

    // If DNS resolved to zero addresses, the hostname doesn't exist.
    if (v4Addrs.length === 0 && v6Addrs.length === 0) {
      return { blocked: true, reason: `DNS resolution failed for ${hostname}` };
    }

    return { blocked: false };
  } catch {
    return { blocked: true, reason: `DNS resolution failed for ${hostname}` };
  }
}
