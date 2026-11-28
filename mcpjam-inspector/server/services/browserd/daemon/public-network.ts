/**
 * A hosted browser that reaches the public internet and nothing else.
 *
 * WHY. An unattended browser goes where a third party's pages send it: a
 * readiness sign-in follows the submitter's authorization server, which can
 * redirect to `http://169.254.169.254/`, to the box's own loopback where the
 * daemon listens, or to any private address the box can see. The picture of
 * that page is then stored as stage evidence. Limiting where credentials are
 * typed does not limit where the browser goes; this does.
 *
 * HOW. Every request Chromium makes goes through the egress proxy the local
 * engine already uses (`local/egress-proxy.ts`), which asks this policy about
 * each destination, resolves the name once, refuses it unless every address
 * is public, and connects to the address it checked. So a redirect, a
 * worker, a WebSocket and a name that resolves privately (DNS rebinding
 * included) are all judged at the one place they cannot route around.
 * Addresses are judged by `egressTier`, the hosted inspector's own rules,
 * and refused in the ranges that only look public (`NOT_GLOBAL`).
 *
 * Booted per session (`MCPJAM_BROWSERD_NETWORK=public`) and announced as
 * `BROWSERD_PUBLIC_NETWORK_FEATURE`, so a caller that needs it refuses a
 * daemon that does not say it is on.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { egressTier } from "../../../utils/egress-tier.js";
import {
  BrowserPolicyError,
  type LocalBrowserSecurityPolicy,
} from "../local/security-policy.js";

/** What the egress proxy asks of a policy. */
export type BrowserEgressPolicy = Pick<
  LocalBrowserSecurityPolicy,
  "allowsRequest" | "resolveDestination" | "isActive" | "onRevoked"
>;

const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Not globally reachable, though `egressTier` calls them public: the IETF,
 * documentation and benchmarking ranges. Kept here rather than in
 * `egressTier`, whose `never` tier the hosted guard refuses in every mode,
 * and `198.18.0.0/15` is where a local VPN's fake-IP DNS answers.
 */
const NOT_GLOBAL = new BlockList();
NOT_GLOBAL.addSubnet("192.0.0.0", 24, "ipv4");
NOT_GLOBAL.addSubnet("192.0.2.0", 24, "ipv4");
NOT_GLOBAL.addSubnet("198.18.0.0", 15, "ipv4");
NOT_GLOBAL.addSubnet("198.51.100.0", 24, "ipv4");
NOT_GLOBAL.addSubnet("203.0.113.0", 24, "ipv4");
NOT_GLOBAL.addSubnet("2001:db8::", 32, "ipv6");
NOT_GLOBAL.addSubnet("2001::", 32, "ipv6"); // Teredo
NOT_GLOBAL.addSubnet("2001:2::", 48, "ipv6"); // benchmarking
NOT_GLOBAL.addSubnet("2002::", 16, "ipv6"); // 6to4, deprecated
NOT_GLOBAL.addSubnet("3fff::", 20, "ipv6"); // documentation
NOT_GLOBAL.addSubnet("64:ff9b:1::", 48, "ipv6"); // local-use NAT64

/** NAT64's well-known prefix reaches the IPv4 address in its last 32 bits. */
const NAT64 = new BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");

function embeddedIpv4(address: string): string | undefined {
  if (isIP(address) !== 6 || !NAT64.check(address, "ipv6")) return undefined;
  const tail = address.split(":").slice(-2);
  if (tail.length === 1 || tail[1]?.includes(".")) return tail.at(-1);
  const [high, low] = tail.map((part) => parseInt(part || "0", 16));
  return [high! >> 8, high! & 255, low! >> 8, low! & 255].join(".");
}

/** Public by `egressTier`, and not in a range that only looks public. */
function isPublicHost(host: string): boolean {
  if (egressTier(host) !== "public") return false;
  const address = host.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 0) return true;
  if (NOT_GLOBAL.check(address, family === 6 ? "ipv6" : "ipv4")) return false;
  const translated = embeddedIpv4(address);
  return translated === undefined || isPublicHost(translated);
}

const REFUSED =
  "this browser reaches public internet addresses only, and this destination is not one.";

/** A web URL whose host is public as written; a name is judged again once resolved. */
export function isPublicWebUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL: nothing to reach.
    return false;
  }
  return WEB_PROTOCOLS.has(url.protocol) && isPublicHost(url.hostname);
}

export function createPublicNetworkPolicy(
  resolve: typeof lookup = lookup,
): BrowserEgressPolicy {
  return {
    isActive: () => true,
    onRevoked: () => () => {},
    allowsRequest: isPublicWebUrl,
    async resolveDestination(hostname, port) {
      const name = hostname.replace(/^\[|\]$/g, "");
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !isPublicHost(name)
      ) {
        throw new BrowserPolicyError(REFUSED);
      }
      const addresses = isIP(name)
        ? [{ address: name, family: isIP(name) }]
        : await resolve(name, { all: true, verbatim: true });
      // Every answer, not the first: the proxy may fall back to any of them.
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => !isPublicHost(address))
      ) {
        throw new BrowserPolicyError(REFUSED);
      }
      return addresses;
    },
  };
}
