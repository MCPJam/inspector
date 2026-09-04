import { Hono } from "hono";
import { describeError, originOf } from "@mcpjam/sdk";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getRequestLogger } from "../../utils/request-logger";
import { classifyError } from "../../utils/error-classify";
import {
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";
import { reportRouteFailureForResponse } from "../../utils/route-error-report.js";

/**
 * `normalized` + `origin` for an OAuth proxy error body.
 *
 * These routes reach the USER's authorization server, so their failures are
 * overwhelmingly configuration (wrong issuer, unreachable `.well-known`,
 * refused connection) rather than an MCPJam outage. Serializing the classified
 * block lets the OAuth debugger say which, instead of showing a bare string.
 */
function describeForBody(error: unknown) {
  const normalized = describeError(error);
  return { normalized, origin: originOf(normalized) };
}

const oauth = new Hono();
const OAUTH_UPSTREAM_URL_HEADER = "X-MCPJam-OAuth-Upstream-URL";

function safeHostname(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * Debug proxy for OAuth flow visualization and testing
 * POST /api/mcp/oauth/debug/proxy
 *
 * This endpoint is specifically for the OAuth Flow debugging tab.
 * It captures full request/response details for visualization.
 *
 * Body: { url: string, method?: string, body?: object, headers?: object }
 */
oauth.post("/debug/proxy", async (c) => {
  let proxyUrl: string | undefined;
  try {
    const { url, method, body, headers, redirect } = await c.req.json();
    proxyUrl = url;
    const result = await executeDebugOAuthProxy({
      url,
      method,
      body,
      headers,
      // This router is mounted only outside hosted mode, so the target is a
      // server on the developer's own machine or network as often as not.
      // The hosted twin in routes/web/oauth.ts keeps httpsOnly: true.
      allowPrivateNetwork: true,
      // Only the two fetch redirect modes we support; anything else is ignored
      // so a crafted value cannot reach fetch().
      ...(redirect === "manual" || redirect === "follow" ? { redirect } : {}),
    });
    return c.json(result);
  } catch (error) {
    const targetUrlHost = safeHostname(proxyUrl);
    if (error instanceof OAuthProxyError) {
      getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
        targetUrlHost,
        oauthPhase: "proxy",
        errorCode: classifyError(error),
        statusCode: error.status,
      });
      return c.json(
        {
          error: error.message,
          // Additive, same reason as the 500 paths below: the debugger
          // gets the classified block, existing readers keep `error`.
          ...describeForBody(error),
        },
        error.status as ContentfulStatusCode,
      );
    }
    getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost,
      oauthPhase: "proxy",
      errorCode: classifyError(error),
    });
    const { normalized, origin } = reportRouteFailureForResponse(
      "[OAuth Debug Proxy] Error",
      error,
      {
        // These proxies exist to reach the USER's authorization server.
        // A refused connection, a bad issuer, or an unreachable
        // .well-known is their configuration, not our outage.
        source: "mcp.oauth.debug-proxy",
        hop: "user_server_hop",
        context: { targetUrlHost },
      },
    );
    return c.json(
      {
        // `error` stays a plain string — the OAuth debugger reads it
        // directly. `normalized`/`origin` are additive so the debugger
        // can render the same attribution the rest of the app shows.
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        normalized,
        origin,
      },
      500,
    );
  }
});

/**
 * Proxy any OAuth-related request to bypass CORS restrictions
 * POST /api/mcp/oauth/proxy
 * Body: { url: string, method?: string, body?: object, headers?: object }
 *
 * @deprecated Use /debug/proxy for debugging or implement proper OAuth client
 */
oauth.post("/proxy", async (c) => {
  let proxyUrl: string | undefined;
  try {
    const { url, method, body, headers } = await c.req.json();
    proxyUrl = url;
    const result = await executeOAuthProxy({
      url,
      method,
      body,
      headers,
      // Local router — see the debug proxy above.
      allowPrivateNetwork: true,
    });
    c.header(OAUTH_UPSTREAM_URL_HEADER, result.finalUrl);
    return c.json(result);
  } catch (error) {
    const targetUrlHost = safeHostname(proxyUrl);
    if (error instanceof OAuthProxyError) {
      getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
        targetUrlHost,
        oauthPhase: "proxy",
        errorCode: classifyError(error),
        statusCode: error.status,
      });
      return c.json(
        {
          error: error.message,
          // Additive, same reason as the 500 paths below: the debugger
          // gets the classified block, existing readers keep `error`.
          ...describeForBody(error),
        },
        error.status as ContentfulStatusCode,
      );
    }
    getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost,
      oauthPhase: "proxy",
      errorCode: classifyError(error),
    });
    const { normalized, origin } = reportRouteFailureForResponse(
      "OAuth proxy error",
      error,
      {
        // These proxies exist to reach the USER's authorization server.
        // A refused connection, a bad issuer, or an unreachable
        // .well-known is their configuration, not our outage.
        source: "mcp.oauth.proxy",
        hop: "user_server_hop",
        context: { targetUrlHost },
      },
    );
    return c.json(
      {
        // `error` stays a plain string — the OAuth debugger reads it
        // directly. `normalized`/`origin` are additive so the debugger
        // can render the same attribution the rest of the app shows.
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        normalized,
        origin,
      },
      500,
    );
  }
});

/**
 * Proxy OAuth metadata requests to bypass CORS restrictions
 * GET /api/mcp/oauth/metadata?url=https://mcp.asana.com/.well-known/oauth-authorization-server/sse
 */
oauth.get("/metadata", async (c) => {
  const metadataUrl = c.req.query("url");
  try {
    if (!metadataUrl) {
      return c.json({ error: "Missing url parameter" }, 400);
    }

    const result = await fetchOAuthMetadata(metadataUrl, {
      // Local router — see the debug proxy above. This is the call that
      // refused an authorization server named `auth.local` on 127.0.0.1.
      allowPrivateNetwork: true,
    });
    if ("status" in result && result.status !== undefined) {
      return c.json(
        {
          error: `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`,
        },
        result.status as ContentfulStatusCode,
      );
    }

    c.header(OAUTH_UPSTREAM_URL_HEADER, result.finalUrl);
    return c.json(result.metadata);
  } catch (error) {
    const targetUrlHost = safeHostname(metadataUrl);
    if (error instanceof OAuthProxyError) {
      getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
        targetUrlHost,
        oauthPhase: "metadata",
        errorCode: classifyError(error),
        statusCode: error.status,
      });
      return c.json(
        {
          error: error.message,
          // Additive, same reason as the 500 paths below: the debugger
          // gets the classified block, existing readers keep `error`.
          ...describeForBody(error),
        },
        error.status as ContentfulStatusCode,
      );
    }
    getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost,
      oauthPhase: "metadata",
      errorCode: classifyError(error),
    });
    const { normalized, origin } = reportRouteFailureForResponse(
      "OAuth metadata proxy error",
      error,
      {
        // These proxies exist to reach the USER's authorization server.
        // A refused connection, a bad issuer, or an unreachable
        // .well-known is their configuration, not our outage.
        source: "mcp.oauth.metadata",
        hop: "user_server_hop",
        context: { targetUrlHost },
      },
    );
    return c.json(
      {
        // `error` stays a plain string — the OAuth debugger reads it
        // directly. `normalized`/`origin` are additive so the debugger
        // can render the same attribution the rest of the app shows.
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        normalized,
        origin,
      },
      500,
    );
  }
});

export default oauth;
