import { Hono } from "hono";
import type { Context } from "hono";
import { describeError } from "@mcpjam/sdk";
import {
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webErrorFromRoute,
} from "./errors.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { classifyError } from "../../utils/error-classify.js";

const oauthWeb = new Hono();
const OAUTH_UPSTREAM_URL_HEADER = "X-MCPJam-OAuth-Upstream-URL";

function safeHostname(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// Require some form of bearer token (guest or WorkOS) on all OAuth proxy routes
oauthWeb.use("*", bearerAuthMiddleware);

// Rate limit guest users on OAuth proxy routes
oauthWeb.use("*", guestRateLimitMiddleware);

function statusToErrorCode(status: number): ErrorCode {
  if (status === 400) return ErrorCode.VALIDATION_ERROR;
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status === 502) return ErrorCode.SERVER_UNREACHABLE;
  if (status === 504) return ErrorCode.TIMEOUT;
  return ErrorCode.INTERNAL_ERROR;
}

function webErrorCompat(c: Context, routeError: WebRouteError) {
  // Through `webErrorFromRoute`, NOT a hand-rolled `c.json`. The hand-rolled
  // version never set `webErrorMeta`, so `requestLogContextMiddleware` had
  // nothing to read: every failure on these routes logged as a bare
  // `internal_error` with no message, no slug, and no origin. Measured on
  // 2026-08-15 as 55 rows in 72h on `/api/web/oauth/metadata` alone — the
  // single largest unattributed class on the whole surface, and structurally
  // invisible to the MCPJam-fault monitor.
  //
  // TODO(hosted-v1.1): Remove `error` once clients migrate to `{ code, message }`.
  // This compatibility key exists for one release to avoid breaking callers that
  // still parse legacy `{ error }` payloads on oauth routes. It rides as an
  // `extras` key, which `webError` spreads into the body ahead of the canonical
  // fields, so the wire shape is unchanged apart from the additions every other
  // `/api/web/*` envelope already carries.
  return webErrorFromRoute(c, routeError, { error: routeError.message });
}

function toRouteError(error: unknown): WebRouteError {
  // Everything goes through `mapRuntimeError`, including errors that already
  // ARE a `WebRouteError`. It backfills `normalized` and resolves the effective
  // `origin`, and `webError` reports neither field unless `normalized` exists —
  // so returning a hand-built `WebRouteError` unclassified, as both branches
  // below used to, produced an envelope and a log row with no attribution at
  // all. It never overrules an origin that is already set.
  //
  // NOTE: no `mcpjam_internal` boundary anywhere on this route, deliberately.
  // These handlers reach the USER's authorization server — an unreachable
  // `.well-known`, a refused connection, or a wrong issuer is theirs, and
  // declaring an internal hop here would page us for exactly the class of
  // third-party outage this program exists to stop paging on.
  if (error instanceof OAuthProxyError) {
    return mapRuntimeError(
      new WebRouteError(
        error.status,
        statusToErrorCode(error.status),
        error.message,
        undefined,
        // Classify from the ORIGINAL, which carries `.status`. Describing the
        // rebuilt `WebRouteError` instead would leave the describer nothing but
        // a message string to pattern-match.
        describeError(error),
      ),
    );
  }
  return mapRuntimeError(error);
}

function getConvexHttpUrl(): string {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }

  return convexUrl;
}

async function proxyConvexOAuthPost(c: Context, path: string) {
  const convexUrl = getConvexHttpUrl();
  const authorization = c.req.header("authorization");
  const payload = await c.req.json();
  const response = await fetch(`${convexUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  return new Response(bodyText, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

/**
 * Proxy OAuth token exchange and client registration requests.
 * POST /api/web/oauth/proxy
 *
 * Mirrors /api/mcp/oauth/proxy with HTTPS-only + private IP blocking.
 * Body: { url: string, method?: string, body?: object, headers?: object }
 */
oauthWeb.post("/proxy", async (c) => {
  let proxyUrl: string | undefined;
  try {
    const { url, method, body, headers } = await c.req.json();
    proxyUrl = url;
    const result = await executeOAuthProxy({
      url,
      method,
      body,
      headers,
      httpsOnly: true,
    });
    c.header(OAUTH_UPSTREAM_URL_HEADER, result.finalUrl);
    return c.json(result);
  } catch (error) {
    getRequestLogger(c, "routes.web.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost: safeHostname(proxyUrl),
      oauthPhase: "proxy",
      errorCode: classifyError(error),
      ...(error instanceof OAuthProxyError ? { statusCode: error.status } : {}),
    });
    return webErrorCompat(c, toRouteError(error));
  }
});

/**
 * Proxy OAuth metadata discovery requests.
 * GET /api/web/oauth/metadata?url=https://...
 *
 * Mirrors /api/mcp/oauth/metadata with HTTPS-only + private IP blocking.
 */
oauthWeb.get("/metadata", async (c) => {
  const metadataUrl = c.req.query("url");
  try {
    if (!metadataUrl) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Missing url parameter",
      );
    }

    const result = await fetchOAuthMetadata(metadataUrl, true);
    if ("status" in result && result.status !== undefined) {
      throw new WebRouteError(
        result.status,
        statusToErrorCode(result.status),
        `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`,
      );
    }

    c.header(OAUTH_UPSTREAM_URL_HEADER, result.finalUrl);
    return c.json(result.metadata);
  } catch (error) {
    getRequestLogger(c, "routes.web.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost: safeHostname(metadataUrl),
      oauthPhase: "metadata",
      errorCode: classifyError(error),
      ...(error instanceof OAuthProxyError ? { statusCode: error.status } : {}),
    });
    return webErrorCompat(c, toRouteError(error));
  }
});

// Pure pass-through proxies to the matching Convex /web/oauth/* endpoints.
// Each handler is identical apart from the path, so register them in a loop
// rather than copy-pasting the try/catch shell four times.
const CONVEX_OAUTH_PROXY_PATHS = [
  "session",
  "tokens",
  "import-tokens",
  "client-secret",
] as const;

for (const path of CONVEX_OAUTH_PROXY_PATHS) {
  oauthWeb.post(`/${path}`, async (c) => {
    try {
      return await proxyConvexOAuthPost(c, `/web/oauth/${path}`);
    } catch (error) {
      return webErrorCompat(c, toRouteError(error));
    }
  });
}

// Local-mode token import — see backend `/web/oauth/import-tokens` for shape.
// The local CLI's `MCPOAuthProvider` uses this to push browser-side
// PKCE-exchanged tokens into Convex so the resolver can read them.
oauthWeb.post("/import-tokens", async (c) => {
  try {
    return await proxyConvexOAuthPost(c, "/web/oauth/import-tokens");
  } catch (error) {
    return webErrorCompat(c, toRouteError(error));
  }
});

/**
 * Debug proxy for OAuth flow visualization (hosted mode).
 * POST /api/web/oauth/debug/proxy
 *
 * Mirrors /api/mcp/oauth/debug/proxy with HTTPS-only + private IP blocking.
 * Body: { url: string, method?: string, body?: object, headers?: object }
 */
oauthWeb.post("/debug/proxy", async (c) => {
  let proxyUrl: string | undefined;
  try {
    const { url, method, body, headers } = await c.req.json();
    proxyUrl = url;
    // Note: no `redirect` option here — this route is always httpsOnly, and the
    // SDK proxy forces `redirect: "manual"` under httpsOnly, so passing one
    // would be dead code. The mcp route (not httpsOnly) is where it applies.
    const result = await executeDebugOAuthProxy({
      url,
      method,
      body,
      headers,
      httpsOnly: true,
    });
    return c.json(result);
  } catch (error) {
    getRequestLogger(c, "routes.web.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost: safeHostname(proxyUrl),
      oauthPhase: "proxy",
      errorCode: classifyError(error),
      ...(error instanceof OAuthProxyError ? { statusCode: error.status } : {}),
    });
    return webErrorCompat(c, toRouteError(error));
  }
});

export default oauthWeb;
