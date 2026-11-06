/**
 * The og:image of a shared conformance run's link:
 * `GET /api/web/conformance-share-card/<token>.png`.
 *
 * NO BEARER AUTH. Crawlers (X, LinkedIn, Slack, Discord) fetch it with no
 * session, the same way they read the page's meta tags. The token in the URL
 * is the credential, and the backend answers only for a link anyone may open,
 * with the score summary the card draws. Any other link is a plain 404.
 */
import { Hono, type Context } from "hono";
import { logger } from "../../utils/logger.js";
import { isConformanceShareLinkToken } from "../../utils/conformance-share-meta-tags.js";
import { conformanceShareCardForToken } from "../../services/conformance-share-card/link-preview.js";

const conformanceShareCard = new Hono();

/** The host the link lives on, for the card's footer (no port, no scheme). */
function siteLabel(hostHeader: string | undefined): string | null {
  const host = (hostHeader ?? "").toLowerCase().split(":")[0]?.trim();
  return host && /^[a-z0-9.-]+$/.test(host) ? host : null;
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
      siteLabel(c.req.header("X-Forwarded-Host") ?? c.req.header("Host")),
    );
  } catch (error) {
    logger.error("[conformance-share-card] render failed", error);
    return c.text("Could not draw this card", 500);
  }
  if (!png) return noCard(c);

  return c.body(png as Uint8Array<ArrayBuffer>, 200, {
    "content-type": "image/png",
    // Crawlers cache what they unfurl anyway. Keep ours short so a link that
    // was narrowed or rotated stops showing its card soon after.
    "cache-control": "public, max-age=300",
    "x-robots-tag": "noindex",
  });
});

export default conformanceShareCard;
