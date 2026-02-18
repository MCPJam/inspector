import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../../utils/logger.js";
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";
import {
  assertBearerToken,
  WebRouteError,
  webError,
  mapRuntimeError,
} from "./errors.js";

const oauthWeb = new Hono();

/**
 * Proxy OAuth token exchange and client registration requests.
 * POST /api/web/oauth/proxy
 *
 * Mirrors /api/mcp/oauth/proxy but requires bearer JWT authentication.
 * Body: { url: string, method?: string, body?: object, headers?: object }
 */
oauthWeb.post("/proxy", async (c) => {
  try {
    assertBearerToken(c);

    const { url, method, body, headers } = await c.req.json();
    const result = await executeOAuthProxy({ url, method, body, headers });
    return c.json(result);
  } catch (error) {
    if (error instanceof OAuthProxyError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

/**
 * Proxy OAuth metadata discovery requests.
 * GET /api/web/oauth/metadata?url=https://...
 *
 * Mirrors /api/mcp/oauth/metadata but requires bearer JWT authentication.
 */
oauthWeb.get("/metadata", async (c) => {
  try {
    assertBearerToken(c);

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
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  }
});

export default oauthWeb;
