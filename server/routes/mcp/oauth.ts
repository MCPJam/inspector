import { Hono } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";

const oauth = new Hono();

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

    // Validate URL format and ensure it's HTTPS
    let metadataUrl: URL;
    try {
      metadataUrl = new URL(url);
      if (metadataUrl.protocol !== "https:") {
        return c.json({ error: "Only HTTPS URLs are allowed" }, 400);
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
