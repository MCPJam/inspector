/**
 * Detects URLs the hosted backend can never reach from its cloud
 * environment: loopback, RFC 1918 private ranges, link-local, and
 * local-only name suffixes. Used to warn that OAuth tokens imported for
 * such an authorization server cannot be auto-refreshed server-side.
 *
 * Mirrored by hand in the backend repo (convex/lib/privateNetworkUrl.ts);
 * keep the classifications in sync.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  return (
    a === 127 || // loopback
    a === 10 || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 169 && b === 254) // link-local
  );
}

function isPrivateIpv6(hostname: string): boolean {
  return (
    hostname === "::1" ||
    hostname.startsWith("fc") || // ULA fc00::/7
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80") // link-local
  );
}

export function isPrivateNetworkUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // WHATWG URL keeps brackets around IPv6 hostnames.
  const host = hostname.replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  return isPrivateIpv4(host);
}
