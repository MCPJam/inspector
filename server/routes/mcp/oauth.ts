import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";

const oauth = new Hono();

/**
 * Proxy any OAuth-related request to bypass CORS restrictions
 * POST /api/mcp/oauth/proxy
 * Body: { url: string, method?: string, body?: object, headers?: object }
 */
oauth.post("/proxy", async (c) => {
  try {
    const {
      url,
      method = "GET",
      body,
      headers: customHeaders,
    } = await c.req.json();

    if (!url) {
      return c.json({ error: "Missing url parameter" }, 400);
    }

    // Validate URL format
    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
      if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
        return c.json({ error: "Invalid protocol" }, 400);
      }
    } catch (error) {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    // Build request headers
    const requestHeaders: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "MCP-Inspector/1.0",
      ...customHeaders,
    };

    // Determine content type from custom headers or default to JSON
    const contentType =
      customHeaders?.["Content-Type"] || customHeaders?.["content-type"];
    const isFormUrlEncoded = contentType?.includes(
      "application/x-www-form-urlencoded",
    );

    if (method === "POST" && body && !contentType) {
      requestHeaders["Content-Type"] = "application/json";
    }

    // Make request to target server
    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
    };

    if (method === "POST" && body) {
      if (isFormUrlEncoded && typeof body === "object") {
        // Convert object to URL-encoded string
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
          params.append(key, String(value));
        }
        fetchOptions.body = params.toString();
      } else {
        // Default to JSON
        fetchOptions.body = JSON.stringify(body);
      }
    }

    const response = await fetch(targetUrl.toString(), fetchOptions);

    // Capture ALL response headers (no CORS restrictions on backend)
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let responseBody: any = null;
    try {
      responseBody = await response.json();
    } catch {
      // Response might not be JSON
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }
    }

    // Return full response with headers
    return c.json({
      status: response.status,
      statusText: response.statusText,
      headers,
      body: responseBody,
    });
  } catch (error) {
    console.error("OAuth proxy error:", error);
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

    // Validate URL format
    let metadataUrl: URL;
    try {
      metadataUrl = new URL(url);
      if (metadataUrl.protocol !== "https:" && metadataUrl.protocol !== "http:") {
        return c.json({ error: "Invalid protocol" }, 400);
      }
    } catch (error) {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    // Fetch OAuth metadata from the server
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

    // Return the metadata with proper CORS headers
    return c.json(metadata);
  } catch (error) {
    console.error("OAuth metadata proxy error:", error);
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
