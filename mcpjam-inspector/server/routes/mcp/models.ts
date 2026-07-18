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

// Bound the upstream fetch so the shared in-flight promise always settles. A
// stalled backend (headers sent, body never finishes) would otherwise leave
// `inflightRefresh` pending forever, wedging every concurrent and subsequent
// request past the last-good fallback. Matches the background refresh timeout.
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

let catalogCache: { data: unknown[]; fetchedAt: number } | null = null;

// A single in-flight refresh shared by all concurrent cache misses. Without
// this, a cold start or TTL-expiry burst fires one full Convex request per
// caller; here they all await the same fetch.
let inflightRefresh: Promise<CatalogResult> | null = null;

type CatalogResult =
  | { ok: true; data: unknown[] }
  | { ok: false; status: 500 | 502; error: string };

/**
 * Fetch + normalize the catalog from Convex. Updates `catalogCache` only on a
 * genuinely usable payload. Never throws — network/parse failures come back as
 * a degraded result so the caller can serve last-good.
 */
async function refreshCatalog(): Promise<CatalogResult> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    return {
      ok: false,
      status: 500,
      error: "Server missing CONVEX_HTTP_URL configuration",
    };
  }

  try {
    const response = await fetch(`${convexHttpUrl}/v1/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("[models] Convex backend error", new Error(errorText), {
        status: response.status,
      });
      return {
        ok: false,
        status: 502,
        error: `Failed to fetch models: ${response.status}`,
      };
    }

    const page = (await response.json()) as { items?: unknown };
    // A real catalog is never empty. Treat a missing/empty/malformed payload as
    // degradation rather than truth — overwriting last-good with `[]` would
    // blank every picker on a backend hiccup (empty pricing table, partial
    // deploy, etc.). The caller serves last-good or 502 instead.
    if (!Array.isArray(page?.items) || page.items.length === 0) {
      logger.error(
        "[models] Convex returned an empty or malformed catalog",
        new Error("empty_or_malformed_catalog")
      );
      return { ok: false, status: 502, error: "Empty or malformed catalog" };
    }

    const data = page.items;
    // Feed the fresh catalog ids into the billing classifier's cache so a new
    // model that just appeared in the picker can't mis-dispatch to BYOK before
    // the hourly cron refresh catches up (see hosted-model-catalog.ts).
    ingestHostedCatalogIds(
      data
        .map((m) => (m as { id?: unknown })?.id)
        .filter((id): id is string => typeof id === "string")
    );
    catalogCache = { data, fetchedAt: Date.now() };
    return { ok: true, data };
  } catch (error) {
    logger.error("[models] Error fetching model metadata", error);
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

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

  // Coalesce concurrent misses onto one upstream refresh.
  if (!inflightRefresh) {
    inflightRefresh = refreshCatalog().finally(() => {
      inflightRefresh = null;
    });
  }
  const result = await inflightRefresh;

  if (result.ok) {
    return c.json({ ok: true, data: result.data });
  }

  // Degraded (upstream error / empty payload / missing config): prefer the last
  // good catalog so a transient failure doesn't collapse the picker to the
  // static snapshot. Only surface the error when we have nothing cached.
  if (catalogCache) {
    return c.json({ ok: true, data: catalogCache.data });
  }
  return c.json({ ok: false, error: result.error }, result.status);
});

/** Reset the in-memory catalog memo and in-flight refresh. Test-only. */
export function __resetModelsCacheForTests(): void {
  catalogCache = null;
  inflightRefresh = null;
}

export default models;
