/**
 * Server-injected <head> tags for a shared conformance run's link
 * (`/conformance/shared/<token>`).
 *
 * The page is client-rendered, so crawlers that unfurl the link (X, LinkedIn,
 * Slack, Discord) only ever see the raw HTML. The SPA fallback in
 * `server/index.ts` splices these tags into `index.html` so the link unfurls
 * as the run's score card. The image itself is drawn per link by
 * `/api/web/conformance-share-card/<token>.png`, which answers only for a link
 * anyone may open.
 */

import { DEFAULT_DOCUMENT_TITLE_TAG } from "./caniuse-meta-tags.js";

const SHARED_RUN_PATH = /^\/conformance\/shared\/([^/]+)\/?$/;

export const CONFORMANCE_SHARE_PAGE_TITLE = "MCP conformance report · MCPJam";

const CONFORMANCE_SHARE_DESCRIPTION =
  "The score of an MCP server's conformance run: each suite's checks, and the protocol version it was tested against.";

/**
 * A share link token: nanoid's alphabet. Older HMAC conformance links do not
 * match, and they get no card (the preview endpoint cannot read them).
 */
export function isConformanceShareLinkToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{10,128}$/.test(token);
}

/** The token of a shared conformance run's page path, or null. */
export function conformanceShareTokenFromPath(path: string): string | null {
  const match = SHARED_RUN_PATH.exec(path);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return isConformanceShareLinkToken(token) ? token : null;
}

export function getConformanceShareTitleTag(): string {
  return `<title>${CONFORMANCE_SHARE_PAGE_TITLE}</title>`;
}

/**
 * `origin` is the absolute origin the link was opened on (e.g.
 * https://app.mcpjam.com); og:image must be an absolute URL.
 */
export function getConformanceShareMetaTagsHtml({
  origin,
  token,
}: {
  origin: string;
  token: string;
}): string {
  // The token is already restricted to [A-Za-z0-9_-]; the origin is built by
  // the caller from a validated host. Neither needs HTML escaping beyond that.
  const pageUrl = `${origin}/conformance/shared/${token}`;
  const imageUrl = `${origin}/api/web/conformance-share-card/${token}.png`;
  return [
    `<meta name="description" content="${CONFORMANCE_SHARE_DESCRIPTION}" />`,
    `<meta property="og:site_name" content="MCPJam" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${pageUrl}" />`,
    `<meta property="og:title" content="${CONFORMANCE_SHARE_PAGE_TITLE}" />`,
    `<meta property="og:description" content="${CONFORMANCE_SHARE_DESCRIPTION}" />`,
    `<meta property="og:image" content="${imageUrl}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="MCP conformance score card" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${CONFORMANCE_SHARE_PAGE_TITLE}" />`,
    `<meta name="twitter:description" content="${CONFORMANCE_SHARE_DESCRIPTION}" />`,
    `<meta name="twitter:image" content="${imageUrl}" />`,
  ].join("\n");
}

/**
 * The absolute origin for a request, from its Host (or X-Forwarded-Host) and
 * forwarded protocol. Null when the host is not a plain hostname, so nothing
 * a client controls is written into the document unchecked.
 */
export function requestOrigin({
  host,
  forwardedHost,
  forwardedProto,
}: {
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
}): string | null {
  const raw = (forwardedHost ?? host ?? "").split(",")[0]!.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(raw)) return null;
  const proto = (forwardedProto ?? "").split(",")[0]!.trim().toLowerCase();
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(raw);
  const scheme =
    proto === "http" || (proto === "" && isLocal) ? "http" : "https";
  return `${scheme}://${raw}`;
}

/** Swap the default title and add the card's tags to `index.html`. */
export function injectConformanceShareMetaTags(
  html: string,
  args: { origin: string; token: string },
): string {
  return html
    .replace(DEFAULT_DOCUMENT_TITLE_TAG, getConformanceShareTitleTag())
    .replace("</head>", `${getConformanceShareMetaTagsHtml(args)}</head>`);
}
