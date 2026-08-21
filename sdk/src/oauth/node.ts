/**
 * Node-only SSRF-hardened OAuth networking, as a standalone entry point.
 *
 * The guard already existed in two places, neither reachable from a Node
 * consumer that is not the Inspector:
 *
 * - The root `@mcpjam/sdk` entry exports the pinned proxy, but importing it
 *   pulls in the whole SDK graph (`ai`, the provider packages, the eval
 *   runtime). A backend action that only wants to fetch OAuth metadata safely
 *   should not have to load a model factory to do it.
 * - `@mcpjam/sdk/browser` exports the RFC 6890 classifier, but stops there by
 *   design. Classification alone leaves the DNS-rebinding window open: it
 *   accepts a bare public hostname and expects the caller to resolve, validate,
 *   and PIN the result. That resolution step is Node-only and lives here.
 *
 * This entry is the supported way to get both halves — the classifier and the
 * pinned transport that actually closes the window — with `node:dns`,
 * `node:http`, and `node:https` as the only runtime dependencies. It exists so
 * `mcpjam-backend` can route its OAuth discovery, token exchange, and refresh
 * through the same implementation the Inspector uses rather than forking a
 * second copy that drifts.
 *
 * Everything here is a re-export. Do not add logic to this file — a divergence
 * between what the Inspector enforces and what the backend enforces is the
 * exact failure this entry exists to prevent.
 */

// Pure RFC 6890 special-use classification plus the pre-flight assertion. Safe
// to call before any socket exists; a bare public hostname passes here and is
// resolved and re-validated by the pinned transport below.
export {
  assertOutboundOAuthUrlAllowed,
  isDisallowedIpAddress,
  isLoopbackOAuthUrl,
  isPrivateHost,
  OAuthOutboundUrlBlockedError,
} from "./ssrf-guard.js";

// DNS-pinned transport. `validateUrl` resolves and classifies without issuing a
// request; the `execute*`/`fetch*` calls resolve once, reject every disallowed
// answer, and pin the surviving addresses into the socket so no second
// resolution can occur. Redirects are re-validated per hop, capped at five, and
// stripped of cross-origin credentials.
export {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
  fetchPinnedPublicDocument,
  OAuthProxyError,
  validateUrl,
} from "../oauth-proxy.js";
export type { OAuthProxyRequest, OAuthProxyResponse } from "../oauth-proxy.js";

// The STREAMING half of the same guarantee. `executeOAuthProxy` buffers, so it
// can carry OAuth metadata but never `text/event-stream`; this one hands the
// body back as a live `ReadableStream`, which is what lets the real MCP
// connection — SSE included — ride the pinned path instead of an unguarded
// `globalThis.fetch`.
export { createPinnedStreamingFetch } from "./pinned-stream-fetch.js";
export type { PinnedStreamingFetchOptions } from "./pinned-stream-fetch.js";
