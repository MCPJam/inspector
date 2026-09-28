/**
 * Indexing Headers Middleware
 *
 * Stamps `X-Robots-Tag: noindex` so search engines keep the app shell out of
 * their indexes. The SPA catch-all answers 200 for every path, so without this
 * a crawler can index every route. Crawling itself stays allowed in robots.txt
 * — a robot has to fetch the response to read this header at all.
 *
 * Separate from securityHeadersMiddleware because the scoping rules differ.
 * The security headers are correct for every host unconditionally; this one is
 * not, and a host conditional inside that function is a place where a mistake
 * silently weakens a real security control.
 *
 * What it skips: the same process answers the caniuse.dev and score.mcpjam.com
 * vanity domains (CANIUSE_LANDING_HOSTS / SCORE_LANDING_HOSTS in config), and
 * those exist to rank — `server/utils/caniuse-meta-tags.ts` keeps their
 * description inside Google's snippet budget and sets a canonical URL.
 * Stamping them noindex would drop both domains out of the index entirely.
 *
 * What it costs on the hosts it does apply to: a logged-out visitor is not
 * turned away there. `mintGuestSessionForDocument` injects a guest bearer into
 * the document, so a cold visitor boots a working product and uses it until
 * the guest credit wall fires. The shell is a top-of-funnel surface, and
 * noindex gives up whatever organic search would have sent it. That is the
 * trade being made, not free cleanup.
 */

import type { Context, Next } from "hono";
import { CANIUSE_LANDING_HOSTS, SCORE_LANDING_HOSTS } from "../config.js";

/**
 * Paths where the URL is itself the credential, so the host exemption must not
 * reach them. score.mcpjam.com is exempt as a host, and `/results/<token>` is
 * exactly what it serves — deep links pass its root redirect untouched (see
 * SCORE_LANDING_HOSTS in config). Without this the score domain would hand out
 * link-token pages with no indexing directive at all, which is weaker than
 * what app.mcpjam.com gives them.
 */
const LINK_TOKEN_PREFIXES = ["/results/", "/bench/results/"];

/**
 * Host header without its port, lowercased — the same read the vanity-domain
 * gates in server/index.ts use, so this middleware and those gates agree on
 * which requests belong to a landing host.
 *
 * Nothing here is a security control: forging `Host` only lets a caller drop
 * the noindex from a response it fetched itself.
 */
function requestHost(c: Context): string {
  return (c.req.header("Host") ?? "").toLowerCase().split(":")[0];
}

/**
 * Indexing directive middleware.
 * Marks responses noindex except on the vanity domains built to rank.
 */
export async function indexingHeadersMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const host = requestHost(c);
  const isLandingHost =
    CANIUSE_LANDING_HOSTS.has(host) || SCORE_LANDING_HOSTS.has(host);
  const isLinkTokenPath = LINK_TOKEN_PREFIXES.some((prefix) =>
    c.req.path.startsWith(prefix),
  );

  if (!isLandingHost || isLinkTokenPath) {
    c.header("X-Robots-Tag", "noindex");
  }

  return next();
}
