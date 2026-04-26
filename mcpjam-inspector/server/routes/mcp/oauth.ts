import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../../utils/logger";
import { getRequestLogger } from "../../utils/request-logger";
import { classifyError } from "../../utils/error-classify";
import {
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";

const oauth = new Hono();

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
    const { url, method, body, headers } = await c.req.json();
    proxyUrl = url;
    const result = await executeDebugOAuthProxy({ url, method, body, headers });
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
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
    getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost,
      oauthPhase: "proxy",
      errorCode: classifyError(error),
    });
    logger.error("[OAuth Debug Proxy] Error", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
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
    const result = await executeOAuthProxy({ url, method, body, headers });
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
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
    getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost,
      oauthPhase: "proxy",
      errorCode: classifyError(error),
    });
    logger.error("OAuth proxy error", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
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

    const result = await fetchOAuthMetadata(metadataUrl);
    if ("status" in result && result.status !== undefined) {
      return c.json(
        {
          error: `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`,
        },
        result.status as ContentfulStatusCode,
      );
    }

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
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
    getRequestLogger(c, "routes.mcp.oauth").event("mcp.oauth.proxy.failed", {
      targetUrlHost,
      oauthPhase: "metadata",
      errorCode: classifyError(error),
    });
    logger.error("OAuth metadata proxy error", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      500,
    );
  }
});

export default oauth;
