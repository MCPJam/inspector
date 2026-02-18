import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../../utils/oauth-proxy.js";
import {
  assertBearerToken,
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
} from "./errors.js";

const oauthWeb = new Hono();

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
  // TODO(hosted-v1.1): Remove `error` once clients migrate to `{ code, message }`.
  // This compatibility key exists for one release to avoid breaking callers that
  // still parse legacy `{ error }` payloads on oauth routes.
  return c.json(
    {
      code: routeError.code,
      message: routeError.message,
      error: routeError.message,
    },
    routeError.status as ContentfulStatusCode,
  );
}

function toRouteError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) {
    return error;
  }
  if (error instanceof OAuthProxyError) {
    return new WebRouteError(
      error.status,
      statusToErrorCode(error.status),
      error.message,
    );
  }
  return mapRuntimeError(error);
}

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
    const result = await executeOAuthProxy({ url, method, body, headers, httpsOnly: true });
    return c.json(result);
  } catch (error) {
    return webErrorCompat(c, toRouteError(error));
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
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Missing url parameter",
      );
    }

    const result = await fetchOAuthMetadata(url, true);
    if ("status" in result && result.status !== undefined) {
      throw new WebRouteError(
        result.status,
        statusToErrorCode(result.status),
        `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`,
      );
    }

    return c.json(result.metadata);
  } catch (error) {
    return webErrorCompat(c, toRouteError(error));
  }
});

export default oauthWeb;
