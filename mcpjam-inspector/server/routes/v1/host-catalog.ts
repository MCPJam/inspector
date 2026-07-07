/**
 * `GET /api/v1/host-catalog` — the stable public URL for the host-compat
 * catalog (CANI-2 data/engine split).
 *
 * The OSS SDK/CLI never learn a `*.convex.site` address: this route is the
 * one public host, proxying the backend's unauthenticated
 * `GET /public/host-catalog` (Convex `marketHostCatalog`) with an in-memory
 * cache. It ALWAYS returns a catalog:
 *
 *   - live fetch OK        → `source: "live"`,    `Cache-Control: max-age=300`
 *   - fetch fails, cache   → last good envelope (serve-stale-on-error)
 *   - fetch fails, nothing → bundled SDK catalog, `source: "bundled"`,
 *                            `no-store` (a local OSS install without Convex
 *                            env lands here and still gets verdicts)
 *
 * Tri-state discipline (runtime-skills.ts): a transient upstream failure is
 * never conflated with "no catalog" — the bundled fallback is an explicit,
 * labeled degradation, not an empty response.
 */
import { Hono } from "hono";
import {
  bundledHostCompatCatalog,
  hostCompatCatalogEnvelopeSchema,
  type HostCompatCatalog,
  type HostCompatCatalogEnvelope,
} from "@mcpjam/sdk/host-compat";

// The Zod-inferred envelope narrows `provenance` to the wire enum; the SDK's
// catalog type also admits `observed` (earned live, never published). Serve
// the SDK-typed catalog under the envelope's wire fields.
type CatalogEnvelope = Omit<HostCompatCatalogEnvelope, "catalog"> & {
  catalog: HostCompatCatalog;
};

const hostCatalog = new Hono();

const UPSTREAM_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 300_000;

type CachedEnvelope = { envelope: CatalogEnvelope; fetchedAt: number };

let cache: CachedEnvelope | null = null;
// Single-flight guard: at most one upstream refresh runs at a time. Concurrent
// requests past the TTL share it instead of stampeding the backend, and the
// one winner updates the cache (so two refreshes can't race to overwrite it).
let inflightRefresh: Promise<CatalogEnvelope | null> | null = null;

/** Test hook — reset module state between cases. */
export function resetHostCatalogCacheForTests(): void {
  cache = null;
  inflightRefresh = null;
}

function bundledEnvelope(): CatalogEnvelope {
  return {
    schemaVersion: 1,
    // Version 0 = "not a backend publish"; consumers compare against >=1.
    version: 0,
    contentHash: "",
    publishedAt: 0,
    catalog: bundledHostCompatCatalog(),
    source: "bundled",
  };
}

async function fetchUpstreamEnvelope(
  convexUrl: string
): Promise<CatalogEnvelope | null> {
  // The abort deadline covers the whole exchange — `fetch` resolves on
  // headers, so the timer must stay armed through `response.json()`.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/public/host-catalog", convexUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    // Validate before caching/serving — a malformed upstream payload must
    // degrade to stale/bundled, never be proxied through to consumers.
    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(body);
    if (!parsed.success) return null;
    return { ...parsed.data, source: "live" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Refresh the cache from upstream, deduped so only one fetch is in flight at a
 * time. The winner writes the cache only if the fetched version is at least
 * the cached one, so a slower/older response can't clobber a newer catalog.
 */
function refreshCache(convexUrl: string): Promise<CatalogEnvelope | null> {
  if (!inflightRefresh) {
    inflightRefresh = fetchUpstreamEnvelope(convexUrl)
      .then((envelope) => {
        if (
          envelope &&
          (!cache || envelope.version >= cache.envelope.version)
        ) {
          cache = { envelope, fetchedAt: Date.now() };
        }
        return envelope;
      })
      .finally(() => {
        inflightRefresh = null;
      });
  }
  return inflightRefresh;
}

hostCatalog.get("/host-catalog", async (c) => {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return c.json(cache.envelope, 200, {
      "Cache-Control": "public, max-age=300",
    });
  }

  const convexUrl = process.env.CONVEX_HTTP_URL;
  const envelope = convexUrl ? await refreshCache(convexUrl) : null;
  if (envelope) {
    return c.json(envelope, 200, { "Cache-Control": "public, max-age=300" });
  }

  // Upstream unavailable: serve the last good envelope past its TTL rather
  // than downgrading consumers that already saw live data — but with
  // revalidation semantics so a downstream cache rechecks on the next request
  // instead of pinning this stale copy for another max-age window (which would
  // mask upstream recovery).
  if (cache) {
    return c.json(cache.envelope, 200, { "Cache-Control": "no-cache" });
  }

  return c.json(bundledEnvelope(), 200, { "Cache-Control": "no-store" });
});

export default hostCatalog;
