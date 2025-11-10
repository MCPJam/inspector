import { Hono } from "hono";
import "../../types/hono";

const models = new Hono();

/**
 * Proxy endpoint to fetch model metadata from Convex backend
 * GET /api/mcp/models
 * Expects Authorization header with the Convex auth token
 */
models.get("/", async (c) => {
  try {
    const authHeader = c.req.header("authorization");

    if (!authHeader) {
      return c.json(
        {
          ok: false,
          error: "Authorization header is required",
        },
        401,
      );
    }

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      return c.json(
        {
          ok: false,
          error: "Server missing CONVEX_HTTP_URL configuration",
        },
        500,
      );
    }

    // Proxy the request to Convex backend with the same auth header
    const response = await fetch(`${convexHttpUrl}/models`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[models] Convex backend error: ${response.status} ${errorText}`,
      );
      return c.json(
        {
          ok: false,
          error: `Failed to fetch models: ${response.status}`,
        },
        response.status,
      );
    }

    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error("[models] Error fetching model metadata:", error);
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default models;
