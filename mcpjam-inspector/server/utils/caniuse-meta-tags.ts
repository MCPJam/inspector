/**
 * Server-injected <head> tags for the caniuse.dev vanity domain.
 *
 * `/embed/host-compare` is a client-rendered SPA route, so social-media
 * crawlers (Discord, X, Slack, Facebook) never run the JS that would set a
 * title/description via React — they only ever see the raw HTML this module
 * produces. The SPA-fallback handler in `server/index.ts` splices this into
 * the shared `index.html` document, host-gated by `CANIUSE_LANDING_HOSTS` so
 * app.mcpjam.com and every other domain keep the default MCPJam Inspector
 * title/tags untouched.
 */

export const CANIUSE_PAGE_TITLE =
  "Can I Use MCP? – Compare MCP Feature Support Across AI Hosts";

const CANIUSE_DESCRIPTION =
  "Compare MCP protocol support across AI hosts and clients — sampling, elicitation, OAuth, resources, and more — side by side. Free, no sign-in required.";

const CANIUSE_CANONICAL_URL = "https://caniuse.dev/";
const CANIUSE_OG_IMAGE_URL = "https://caniuse.dev/caniuse-og-dark-1200x630.png";

/** The default document title this module's title replacement targets. */
export const DEFAULT_DOCUMENT_TITLE_TAG = "<title>MCPJam Inspector</title>";

export function getCaniuseTitleTag(): string {
  return `<title>${CANIUSE_PAGE_TITLE}</title>`;
}

export function getCaniuseMetaTagsHtml(): string {
  return [
    `<meta name="description" content="${CANIUSE_DESCRIPTION}" />`,
    `<meta property="og:site_name" content="Can I Use MCP" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${CANIUSE_CANONICAL_URL}" />`,
    `<meta property="og:title" content="${CANIUSE_PAGE_TITLE}" />`,
    `<meta property="og:description" content="${CANIUSE_DESCRIPTION}" />`,
    `<meta property="og:image" content="${CANIUSE_OG_IMAGE_URL}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${CANIUSE_PAGE_TITLE}" />`,
    `<meta name="twitter:description" content="${CANIUSE_DESCRIPTION}" />`,
    `<meta name="twitter:image" content="${CANIUSE_OG_IMAGE_URL}" />`,
  ].join("\n");
}
