/**
 * hosted-model-catalog.ts — the authoritative "is this a MCPJam-hosted model?"
 * check for server-side billing dispatch.
 *
 * Historically this was a pure membership test against the static
 * `MCPJAM_PROVIDED_MODEL_IDS` array (`isMCPJamProvidedModel`). Billing keys on
 * it: a hosted model bills to MCPJam credits; anything else falls through to
 * org/BYOK key derivation. That coupling meant every backend model addition
 * required a synchronized inspector edit, and a hosted model missing from the
 * array would silently mis-dispatch to the BYOK path.
 *
 * This service absorbs a DYNAMIC catalog (the backend `/v1/models` route)
 * behind the same synchronous check, without changing behavior:
 *
 *   isHostedCatalogModel(id) === (id ∈ static seed) OR (id ∈ backend catalog)
 *
 * The union with the static seed is what makes this safe:
 *   • Deploy order is irrelevant — the inspector can ship before the backend
 *     bulk-adds models; the seed already covers today's set.
 *   • A catalog outage is safe — the seed keeps every existing model billing
 *     correctly; the fetch only ever ADDS ids, never removes seed ids.
 *
 * The check is SYNCHRONOUS against a warm in-memory cache so callers
 * (resolveModelSource, chat dispatch, evals) stay synchronous. Cold start with
 * the catalog unreachable degrades to seed-only — i.e. the exact pre-service
 * behavior.
 */

import { getCanonicalModelId, MCPJAM_PROVIDED_MODEL_IDS } from "@/shared/types";
import { logger } from "../utils/logger.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly, matches the backend cron
const FETCH_TIMEOUT_MS = 10_000;

// Static seed: byte-identical to the legacy isMCPJamProvidedModel membership.
// Canonical (slash-prefixed) ids. Never mutated — the dynamic catalog only
// unions on top of it.
const SEED_IDS: ReadonlySet<string> = new Set(MCPJAM_PROVIDED_MODEL_IDS);

// Dynamic ids fetched from the backend catalog. `null` until the first
// successful refresh; on refresh failure the previous value is retained (stale
// but safe) rather than being cleared.
let catalogIds: Set<string> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

function catalogUrl(): string | undefined {
  const base = process.env.CONVEX_HTTP_URL;
  return base ? `${base.replace(/\/$/, "")}/v1/models` : undefined;
}

/**
 * Fetch the backend hosted-model catalog and return the set of canonical model
 * ids, or `null` on any failure (non-2xx, timeout, malformed/empty payload).
 * The catalog route returns the canonical envelope `{ items: [{ id, ... }] }`
 * and always lists every allowed model, so an empty `items` is treated as a
 * failed/implausible fetch rather than an authoritative empty catalog.
 */
async function fetchCatalogIds(): Promise<Set<string> | null> {
  const url = catalogUrl();
  if (!url) {
    logger.warn(
      "[hosted-model-catalog] CONVEX_HTTP_URL is not set; hosted-model billing " +
        "falls back to the static seed only"
    );
    return null;
  }

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("[hosted-model-catalog] catalog fetch returned non-2xx", {
        status: res.status,
      });
      return null;
    }
    const body = (await res.json()) as { items?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.items) || body.items.length === 0) {
      logger.warn(
        "[hosted-model-catalog] catalog payload missing/empty items array"
      );
      return null;
    }
    const ids = new Set<string>();
    for (const item of body.items) {
      if (typeof item?.id === "string" && item.id.length > 0) {
        ids.add(item.id);
      }
    }
    if (ids.size === 0) {
      logger.warn("[hosted-model-catalog] catalog yielded no usable ids");
      return null;
    }
    return ids;
  } catch (error) {
    logger.warn("[hosted-model-catalog] catalog fetch threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Refresh the dynamic catalog once. On failure the prior cache is retained and
 * a warn is emitted (which also alerts via Sentry) — billing keeps working off
 * the seed, so this is a degraded-but-safe condition, not an outage. In-flight
 * refreshes are deduped so a manual refresh can't race the interval.
 */
export function refreshHostedModelCatalog(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const fresh = await fetchCatalogIds();
    if (fresh) {
      const added = [...fresh].filter((id) => !SEED_IDS.has(id)).length;
      catalogIds = fresh;
      logger.debug("[hosted-model-catalog] refreshed", {
        catalogSize: fresh.size,
        beyondSeed: added,
      });
    }
    // On failure keep the prior catalogIds (stale but safe).
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Start the boot-time fetch + hourly interval refresh. Memoized: safe to call
 * from every production entrypoint (index.ts and app.ts) — only the first call
 * wires anything up. The initial refresh is fire-and-forget so boot never
 * blocks on backend availability (cold start = seed-only = legacy behavior).
 */
export function startHostedModelCatalogRefresh(): void {
  if (started) return;
  started = true;

  void refreshHostedModelCatalog();

  refreshTimer = setInterval(() => {
    void refreshHostedModelCatalog();
  }, REFRESH_INTERVAL_MS);
  // Don't keep the process alive just for the refresh timer.
  refreshTimer.unref?.();
}

/**
 * Whether `modelId` is a MCPJam-hosted model — the classification server-side
 * billing dispatch keys on. Synchronous (reads the warm cache). Union of the
 * static seed and the dynamic backend catalog; canonicalizes the id the same
 * way the legacy `isMCPJamProvidedModel` did, so this is a drop-in replacement.
 */
export function isHostedCatalogModel(
  modelId: string,
  provider?: string
): boolean {
  const canonical = getCanonicalModelId(modelId, provider);
  if (SEED_IDS.has(canonical)) return true;
  return catalogIds?.has(canonical) ?? false;
}

// ── Test hooks ────────────────────────────────────────────────────────────

/** Seed the dynamic catalog directly (bypasses the network). */
export function __setHostedCatalogForTests(ids: Iterable<string>): void {
  catalogIds = new Set(ids);
}

/** Reset all module state to a cold start. */
export function __resetHostedModelCatalogForTests(): void {
  catalogIds = null;
  refreshInFlight = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  started = false;
}
