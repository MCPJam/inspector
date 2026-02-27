import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../../utils/logger";
import {
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";

const oauth = new Hono();

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
  try {
    const { url, method, body, headers } = await c.req.json();
    const result = await executeDebugOAuthProxy({ url, method, body, headers });
    return c.json(result);
  } catch (error) {
    if (error instanceof OAuthProxyError) {
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
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
  try {
    const { url, method, body, headers } = await c.req.json();
    const result = await executeOAuthProxy({ url, method, body, headers });
    return c.json(result);
  } catch (error) {
    if (error instanceof OAuthProxyError) {
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
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
  try {
    const url = c.req.query("url");
    if (!url) {
      return c.json({ error: "Missing url parameter" }, 400);
    }

    const result = await fetchOAuthMetadata(url);
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
    if (error instanceof OAuthProxyError) {
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    }
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
