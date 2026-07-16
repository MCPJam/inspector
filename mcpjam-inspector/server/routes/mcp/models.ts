import { Hono } from "hono";
import "../../types/hono";
import { logger } from "../../utils/logger";

const models = new Hono();

/**
 * Proxy endpoint to fetch the model catalog from the Convex backend.
 * GET /api/mcp/models
 *
 * Reads the backend's PUBLIC, keyless catalog (`/v1/models`) so the picker
 * works for guests too — the catalog is identical for every caller now that
 * guests are no longer model-curated (enforcement is spend caps). No
 * Authorization header is required or forwarded. The public route returns a
 * `{ items }` page; we normalize it to the `{ ok, data }` envelope the client
 * already consumes.
 */
models.get("/", async (c) => {
  try {
    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      return c.json(
        {
          ok: false,
          error: "Server missing CONVEX_HTTP_URL configuration",
        },
        500
      );
    }

    const response = await fetch(`${convexHttpUrl}/v1/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("[models] Convex backend error", new Error(errorText), {
        status: response.status,
      });
      return c.json(
        {
          ok: false,
          error: `Failed to fetch models: ${response.status}`,
        },
        502
      );
    }

    const page = (await response.json()) as { items?: unknown };
    const data = Array.isArray(page?.items) ? page.items : [];
    return c.json({ ok: true, data });
  } catch (error) {
    logger.error("[models] Error fetching model metadata", error);
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default models;
