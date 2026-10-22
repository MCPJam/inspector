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
 *
 * Credential pages also get `Referrer-Policy: no-referrer`. A page whose URL
 * is a bearer credential — a share link, an OAuth callback still holding its
 * `?code=` — must not hand that URL to whatever it loads or links to. The
 * global `strict-origin-when-cross-origin` already trims cross-origin
 * referers to the origin, but same-origin requests still carry the full URL
 * (the PostHog relay at `/tlm` among them, which is how share tokens reached
 * PostHog), and a downgrade or an older browser sends it everywhere. This
 * middleware runs after `securityHeadersMiddleware` in both entries, so its
 * value replaces the global one on exactly those pages.
 */

import type { Context, Next } from "hono";
import { CANIUSE_LANDING_HOSTS, SCORE_LANDING_HOSTS } from "../config.js";
import {
  isReplayBlockedLocation,
  matchCredentialPath,
} from "../../shared/credential-urls.js";

/**
 * Whether the URL is itself the credential, so the host exemption must not
 * reach it. score.mcpjam.com is exempt as a host, and `/results/<token>` is
 * exactly what it serves — deep links pass its root redirect untouched (see
 * SCORE_LANDING_HOSTS in config). Without this the score domain would hand out
 * link-token pages with no indexing directive at all, which is weaker than
 * what app.mcpjam.com gives them.
 *
 * Every path-secret route in the credential registry
 * (`shared/credential-urls.ts`), not a list of our own: a list here would
 * miss the next share route the way it missed `/conformance/shared/<token>`.
 */
function isLinkTokenPath(path: string): boolean {
  return matchCredentialPath(path) !== null;
}

/**
 * Whether this request's URL carries a credential anywhere the registry
 * knows of: a path secret, a callback route, or a secret query key on any
 * path. The fragment never reaches the server, so the query is all there is
 * beyond the path.
 */
function isCredentialPage(c: Context): boolean {
  const url = new URL(c.req.url);
  return isReplayBlockedLocation({
    pathname: url.pathname,
    search: url.search,
  });
}

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
 * Marks responses noindex except on the vanity domains built to rank, and
 * credential pages no-referrer.
 */
export async function indexingHeadersMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  const host = requestHost(c);
  const isLandingHost =
    CANIUSE_LANDING_HOSTS.has(host) || SCORE_LANDING_HOSTS.has(host);
  if (!isLandingHost || isLinkTokenPath(c.req.path)) {
    c.header("X-Robots-Tag", "noindex");
  }

  if (isCredentialPage(c)) {
    // Replaces the global value securityHeadersMiddleware set before us.
    c.header("Referrer-Policy", "no-referrer");
  }

  return next();
}
