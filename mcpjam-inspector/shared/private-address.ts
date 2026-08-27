/**
 * Detects URLs the hosted backend can never reach from its cloud
 * environment: loopback, RFC 1918 private ranges, link-local, and
 * local-only name suffixes.
 *
 * Two callers, both needing the same answer from different sides:
 *  - the client warns that tokens imported for such an authorization server
 *    cannot be auto-refreshed server-side;
 *  - the local server re-asserts it before refreshing one itself, so a bad
 *    backend response cannot steer that refresh at a public host.
 *
 * Lives in `shared/` for exactly that reason — it was client-only, and a
 * second copy under `server/` would have been the third hand-mirrored one.
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
  let host = hostname.replace(/^\[|\]$/g, "");
  // A terminal dot is the same NAME to a resolver ("localhost." resolves to
  // loopback) but a different STRING to every comparison below, so `http://
  // localhost./` was classified public and the refresh refused to run.
  host = host.replace(/\.+$/, "");
  if (!host) return false;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.includes(":")) {
    // IPv4-mapped IPv6. `new URL()` rewrites the dotted spelling into hex
    // (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), so judging only the dotted
    // form classified a parsed loopback URL as public.
    const mappedDotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
    if (mappedDotted) return isPrivateIpv4(mappedDotted[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      return isPrivateIpv4(
        `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${
          low & 0xff
        }`
      );
    }
    return isPrivateIpv6(host);
  }
  return isPrivateIpv4(host);
}
