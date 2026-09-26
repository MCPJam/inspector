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

import {
  getCanonicalModelId,
  hostedDisplayNameFromCanonicalId,
  hostedModelDefinitionsFromSnapshot,
  hostedProviderFromCanonicalId,
  MCPJAM_PROVIDED_MODEL_IDS,
  type Model,
  type ModelDefinition,
} from "@/shared/types";
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
 * Feed a freshly-fetched catalog id set into the warm cache directly. The
 * picker proxy (`GET /api/mcp/models`) already fetches the same `/v1/models`
 * catalog on demand, so handing its result here keeps the billing classifier
 * current between hourly cron refreshes — without which a brand-new model can
 * show in the picker and then mis-dispatch to BYOK because this cache hasn't
 * refreshed yet. Empty input is ignored (never clobber a good cache with a
 * failed/partial fetch).
 *
 * ADDITIVE ONLY: this warm signal never removes ids. The picker proxy fetch can
 * be partial/truncated, and replacing the set with a truncated response would
 * drop live hosted models, misclassifying them as BYOK (billing mis-dispatch)
 * until the next hourly refresh. We union into the current set instead; pruning
 * of genuinely-removed ids is left to refreshHostedModelCatalog(), which
 * replaces from a validated full fetch.
 */
export function ingestHostedCatalogIds(ids: Iterable<string>): void {
  const fresh = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) fresh.add(id);
  }
  if (fresh.size === 0) return;
  const merged = new Set(catalogIds ?? []);
  for (const id of fresh) merged.add(id);
  catalogIds = merged;
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

/**
 * Billing classification for a RESOLVED model definition: `isHostedCatalogModel`
 * plus the one fact the id and provider cannot carry — an explicit
 * `hosted: false` from the picker.
 *
 * 25 of the bare BYOK ids in `SUPPORTED_MODELS` (`claude-fable-5`, `gpt-5-nano`,
 * `gemini-2.5-pro`, …) canonicalize, with their provider, to a hosted twin
 * (`anthropic/claude-fable-5`, `openai/gpt-5-nano`, …). That canonicalization
 * is deliberate — legacy host pins store bare hosted ids and must keep billing
 * to MCPJam — so `(id, provider)` alone cannot say whether the user picked the
 * free row or the row under "Your providers". Only the picker knows, and it
 * stamps its own-provider rows `hosted: false` (see `ModelDefinition.hosted`).
 *
 * Honouring that flag from a request body is safe: `false` only ever moves a
 * turn OFF MCPJam credits and onto the org's own configured key, which the
 * org-BYOK path then verifies exists. A client cannot opt INTO MCPJam billing
 * this way — `true` and absent both fall through to the id-based check, so
 * nothing a body says can promote a non-hosted id.
 */
export function isHostedModelDefinition(model: {
  id: string | Model;
  provider?: string;
  hosted?: boolean;
}): boolean {
  if (model.hosted === false) return false;
  return isHostedCatalogModel(String(model.id), model.provider);
}

// Rows for `hostedCatalogModelDefinitions`, rebuilt only when `catalogIds` is
// replaced. Every writer assigns a new Set, so identity is the version.
let definitionsCache: {
  ids: Set<string> | null;
  rows: ModelDefinition[];
} | null = null;

/**
 * The hosted catalog as model rows: the checked-in snapshot first, then every
 * id the live catalog has reported beyond it. Lookups that used to read only
 * the snapshot (provider derivation, "is this a known model?", hosted-id
 * suggestions) fall through to the live catalog this way, so a model the
 * backend added after the snapshot was generated is known without a
 * regeneration. Cold start with the catalog unreachable is the snapshot alone.
 */
export function hostedCatalogModelDefinitions(): ModelDefinition[] {
  if (definitionsCache && definitionsCache.ids === catalogIds) {
    return definitionsCache.rows;
  }
  const rows = hostedModelDefinitionsFromSnapshot();
  for (const id of catalogIds ?? []) {
    if (SEED_IDS.has(id)) continue;
    rows.push({
      id,
      name: hostedDisplayNameFromCanonicalId(id),
      provider: hostedProviderFromCanonicalId(id),
      hosted: true,
    });
  }
  definitionsCache = { ids: catalogIds, rows };
  return rows;
}

// ── Test hooks ────────────────────────────────────────────────────────────

/** Seed the dynamic catalog directly (bypasses the network). */
export function __setHostedCatalogForTests(ids: Iterable<string>): void {
  catalogIds = new Set(ids);
}

/** Reset all module state to a cold start. */
export function __resetHostedModelCatalogForTests(): void {
  catalogIds = null;
  definitionsCache = null;
  refreshInFlight = null;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  started = false;
}
