import { Hono } from "hono";
import "../../types/hono";
import { logger } from "../../utils/logger";
import { ingestHostedCatalogIds } from "../../services/hosted-model-catalog.js";

const models = new Hono();

/**
 * How long a successful catalog fetch is served from memory before we hit the
 * backend again. The catalog only changes on the hourly pricing cron, so 60s
 * is generous freshness while it bounds unauthenticated amplification: in
 * hosted mode this route is internet-exposed and keyless, and every miss is a
 * Convex function call returning the full (~hundreds-of-KB) catalog. The memo
 * is per-process; other replicas keep their own.
 */
const CATALOG_TTL_MS = 60_000;

let catalogCache: { data: unknown[]; fetchedAt: number } | null = null;

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
 *
 * Served in BOTH local and hosted mode (see middleware/hosted-partition.ts):
 * it's a read-only public proxy with no local-machine capability.
 */
models.get("/", async (c) => {
  // Serve the warm memo while it's fresh — avoids re-hitting Convex on every
  // picker mount. Fresh fetches (below) are what feed the billing classifier,
  // so a memo hit doesn't need to re-ingest: the ids are unchanged.
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return c.json({ ok: true, data: catalogCache.data });
  }

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
      // Serve the last good catalog if we have one — a transient backend blip
      // shouldn't collapse the picker to the static snapshot.
      if (catalogCache) {
        return c.json({ ok: true, data: catalogCache.data });
      }
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
    // Feed the fresh catalog ids into the billing classifier's cache so a new
    // model that just appeared in the picker can't mis-dispatch to BYOK before
    // the hourly cron refresh catches up (see hosted-model-catalog.ts).
    ingestHostedCatalogIds(
      data
        .map((m) => (m as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === "string")
    );
    catalogCache = { data, fetchedAt: Date.now() };
    return c.json({ ok: true, data });
  } catch (error) {
    logger.error("[models] Error fetching model metadata", error);
    // Same last-good fallback for network/parse errors.
    if (catalogCache) {
      return c.json({ ok: true, data: catalogCache.data });
    }
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/** Reset the in-memory catalog memo. Test-only. */
export function __resetModelsCacheForTests(): void {
  catalogCache = null;
}

export default models;
