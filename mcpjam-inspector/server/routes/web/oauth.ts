import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { logger } from "../../utils/logger.js";

const oauthWeb = new Hono();

/**
 * Extracts and validates a bearer token from the Authorization header.
 * Reused from the main web routes to authenticate hosted-mode callers.
 */
function assertBearerToken(c: any): string {
  const authHeader = c.req.header("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing or invalid bearer token"), {
      status: 401,
    });
  }
  return authHeader.slice("Bearer ".length);
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

    const {
      url,
      method = "GET",
      body,
      headers: customHeaders,
    } = await c.req.json();

    if (!url) {
      return c.json({ error: "Missing url parameter" }, 400);
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
      if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
        return c.json({ error: "Invalid protocol" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    const requestHeaders: Record<string, string> = {
      "User-Agent": "MCP-Inspector/1.0",
      ...customHeaders,
    };

    const contentType =
      customHeaders?.["Content-Type"] || customHeaders?.["content-type"];
    const isFormUrlEncoded = contentType?.includes(
      "application/x-www-form-urlencoded",
    );

    if (method === "POST" && body && !contentType) {
      requestHeaders["Content-Type"] = "application/json";
    }

    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (method === "POST" && body) {
      if (isFormUrlEncoded && typeof body === "object") {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          params.append(key, String(value));
        }
        fetchOptions.body = params.toString();
      } else if (typeof body === "string") {
        fetchOptions.body = body;
      } else {
        fetchOptions.body = JSON.stringify(body);
      }
    }

    const response = await fetch(targetUrl.toString(), fetchOptions);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let responseBody: any = null;
    try {
      responseBody = await response.json();
    } catch {
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }
    }

    return c.json({
      status: response.status,
      statusText: response.statusText,
      headers,
      body: responseBody,
    });
  } catch (error: any) {
    if (error?.status === 401) {
      return c.json(
        { code: "UNAUTHORIZED", message: error.message },
        401,
      );
    }
    logger.error("OAuth web proxy error", error);
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

    let metadataUrl: URL;
    try {
      metadataUrl = new URL(url);
      if (
        metadataUrl.protocol !== "https:" &&
        metadataUrl.protocol !== "http:"
      ) {
        return c.json({ error: "Invalid protocol" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    const response = await fetch(metadataUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "MCP-Inspector/1.0",
      },
    });

    if (!response.ok) {
      return c.json(
        {
          error: `Failed to fetch OAuth metadata: ${response.status} ${response.statusText}`,
        },
        response.status as ContentfulStatusCode,
      );
    }

    const metadata = (await response.json()) as Record<string, unknown>;
    return c.json(metadata);
  } catch (error: any) {
    if (error?.status === 401) {
      return c.json(
        { code: "UNAUTHORIZED", message: error.message },
        401,
      );
    }
    logger.error("OAuth web metadata proxy error", error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      500,
    );
  }
});

export default oauthWeb;
