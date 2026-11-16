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
 * Addresses are judged by `egressTier`, the hosted inspector's own rules.
 *
 * Booted per session (`MCPJAM_BROWSERD_NETWORK=public`) and announced as
 * `BROWSERD_PUBLIC_NETWORK_FEATURE`, so a caller that needs it refuses a
 * daemon that does not say it is on.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
  return (
    WEB_PROTOCOLS.has(url.protocol) && egressTier(url.hostname) === "public"
  );
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
        egressTier(name) !== "public"
      ) {
        throw new BrowserPolicyError(REFUSED);
      }
      const addresses = isIP(name)
        ? [{ address: name, family: isIP(name) }]
        : await resolve(name, { all: true, verbatim: true });
      // Every answer, not the first: the proxy may fall back to any of them.
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => egressTier(address) !== "public")
      ) {
        throw new BrowserPolicyError(REFUSED);
      }
      return addresses;
    },
  };
}
