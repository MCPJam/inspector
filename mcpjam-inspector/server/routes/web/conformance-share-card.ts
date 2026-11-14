/**
 * The og:image of a shared conformance run's link:
 * `GET /api/web/conformance-share-card/<token>.png`.
 *
 * NO BEARER AUTH. Crawlers (X, LinkedIn, Slack, Discord) fetch it with no
 * session, the same way they read the page's meta tags. The token in the URL
 * is the credential, and the backend answers only for a link anyone may open,
 * with the score summary the card draws. Any other link is a plain 404.
 *
 * Callers get a budget of backend lookups (lookup-limit.ts); an answer still
 * fresh (10 seconds) costs nothing. Past the budget the route answers 429.
 * Nothing a caller sends can widen the cache: the token is the only free part
 * of the key, and the footer's host comes from a fixed list.
 */
import { Hono, type Context } from "hono";
import { ALLOWED_HOSTS } from "../../config.js";
import { getAttestedClientIp } from "../../utils/client-ip.js";
import { isConformanceShareLinkToken } from "../../utils/conformance-share-meta-tags.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import {
  ShareCardLookupLimited,
  ShareCardUnavailable,
  conformanceShareCardForToken,
} from "../../services/conformance-share-card/link-preview.js";
import {
  SHARE_CARD_LOOKUP_WINDOW_MS,
  admitShareCardLookup,
} from "../../services/conformance-share-card/lookup-limit.js";

const conformanceShareCard = new Hono();

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The host for the card's footer (no port, no scheme), only when it is one
 * this deployment serves: an allowed host, or localhost in development. A
 * Host or X-Forwarded-Host the caller made up gets no label, so it cannot
 * mint new cache entries for a link.
 */
export function shareCardSiteLabel(
  hostHeader: string | undefined,
): string | null {
  const host = (hostHeader ?? "")
    .split(",")[0]!
    .trim()
    .toLowerCase()
    .split(":")[0];
  if (!host) return null;
  return ALLOWED_HOSTS.includes(host) || LOCAL_HOSTS.has(host) ? host : null;
}

// An explicit 404, not `c.notFound()`: the route exists, the card does not.
const noCard = (c: Context) => c.text("No card for this link", 404);

conformanceShareCard.get("/:file", async (c) => {
  const file = c.req.param("file");
  const token = file.endsWith(".png") ? file.slice(0, -4) : "";
  if (!isConformanceShareLinkToken(token)) return noCard(c);

  let png: Uint8Array | null;
  try {
    png = await conformanceShareCardForToken(
      token,
      shareCardSiteLabel(
        c.req.header("X-Forwarded-Host") ?? c.req.header("Host"),
      ),
      () => admitShareCardLookup(getAttestedClientIp(c)),
    );
  } catch (error) {
    if (error instanceof ShareCardLookupLimited) {
      c.header(
        "retry-after",
        String(Math.ceil(SHARE_CARD_LOOKUP_WINDOW_MS / 1000)),
      );
      return c.text("Too many card requests. Try again later.", 429);
    }
    // Not cached, and not cacheable downstream: the next fetch asks again.
    c.header("cache-control", "no-store");
    if (error instanceof ShareCardUnavailable) {
      reportRouteFailure("conformance share card preview unavailable", error, {
        source: "web.conformance-share-card.preview",
        hop: "mcpjam_internal",
      });
      return c.text(
        "This card is not available right now. Try again later.",
        503,
      );
    }
    reportRouteFailure("conformance share card render failed", error, {
      source: "web.conformance-share-card.render",
      hop: "mcpjam_internal",
    });
    return c.text("Could not draw this card. Try again later.", 500);
  }
  if (!png) return noCard(c);

  return c.body(png as Uint8Array<ArrayBuffer>, 200, {
    "content-type": "image/png",
    // Private, so no shared cache keeps serving a card after its link is
    // narrowed, rotated or revoked. Crawlers keep what they already unfurled;
    // that part is theirs.
    "cache-control": "private, max-age=10",
    "x-robots-tag": "noindex",
  });
});

export default conformanceShareCard;
