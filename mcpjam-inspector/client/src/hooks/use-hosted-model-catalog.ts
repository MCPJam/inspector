import { useEffect, useState } from "react";
import { track } from "@/lib/analytics";
import {
  hostedModelDefinitionsFromSnapshot,
  hostedProviderFromCanonicalId,
  type ModelDefinition,
  type ModelObservationKey,
  type ModelObservations,
  type ModelObservationStatus,
} from "@/shared/types";
import type { OpenRouterModel } from "@/types/model-metadata";

/**
 * The MCPJam hosted-model catalog for the picker, sourced from the backend
 * (`GET /api/mcp/models`) instead of the static `SUPPORTED_MODELS` list, so
 * models the backend adds appear with no inspector release.
 *
 * Guarantees the picker is NEVER empty:
 *   live      → the fresh backend catalog
 *   fallback  → last-good localStorage cache, else the static hosted subset
 *
 * `/api/mcp/models` is a PUBLIC proxy of the backend's keyless `/v1/models`
 * catalog, so signed-in users AND guests fetch the same live catalog; only
 * offline/Electron or a failed fetch resolves to `fallback` off the
 * cache/static list. The org-config precedence path is unaffected — this only
 * supplies the hosted ("free") source that composition unions with BYOK/org
 * models.
 */

// v2 invalidated pre-un-gating caches: v1 entries persisted explicit
// `guestAllowed: false` for then-premium models, and applyGuestModelLocks reads
// that explicit `false` as authoritative (the `?? isMCPJamGuestAllowedModel`
// fallback only fires on null/undefined), so a stale v1 cache would keep those
// models locked for guests despite the new un-gating.
// v3 drops caches written before rows carried catalog observations, release
// dates and `supportedParametersComplete`, so the offline fallback never mixes
// the two shapes.
const STORAGE_KEY = "mcpjam.hostedModelCatalog.v3";

export type HostedCatalogStatus = "loading" | "live" | "fallback";

export interface HostedModelCatalogState {
  hostedCatalog: ModelDefinition[];
  status: HostedCatalogStatus;
}

/**
 * Derive the provider key from a canonical (slash-prefixed) catalog id (e.g.
 * "anthropic/claude-haiku-4.5" → "anthropic"). Re-exported from shared so the
 * live catalog mapping and the snapshot fallback agree on prefix→provider.
 */
export const providerFromCanonicalId = hostedProviderFromCanonicalId;

const OBSERVATION_KEYS: readonly ModelObservationKey[] = [
  "tools",
  "vision",
  "temperature",
  "openRouterZdr",
  "gatewayZdr",
  "gatewayNoTraining",
];

const OBSERVATION_STATUSES: ReadonlySet<string> = new Set<ModelObservationStatus>(
  ["supported", "unsupported", "unknown", "all", "some", "none"]
);

/**
 * Epoch ms from a catalog timestamp. The DTO mixes seconds (`created`,
 * `released`) and ms (`deprecated_at`), so a value below 1e11 is read as
 * seconds (1e11 ms is 1973; 1e11 s is year 5138). Zero, negative and
 * non-numeric values are "not reported": the legacy DTO hard-codes
 * `created: 0`.
 */
export function catalogTimestampToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 1e11 ? value * 1000 : value;
}

function catalogObservations(
  raw: OpenRouterModel["observations"]
): ModelObservations | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const observations: ModelObservations = {};
  for (const key of OBSERVATION_KEYS) {
    const entry = raw[key];
    if (!entry || typeof entry !== "object") continue;
    // An unrecognized status is not evidence of anything; leave the key
    // absent so it reads as unknown.
    if (typeof entry.status !== "string") continue;
    if (!OBSERVATION_STATUSES.has(entry.status)) continue;
    const observedAt = catalogTimestampToMs(entry.observedAt);
    observations[key] = {
      status: entry.status as ModelObservationStatus,
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      ...(observedAt !== undefined ? { observedAt } : {}),
    };
  }
  return Object.keys(observations).length > 0 ? observations : undefined;
}

/**
 * Map one backend catalog row to a picker row. Every observation field is
 * optional and copied only when present, so a response from a backend that
 * predates them yields exactly the rows it did before.
 */
export function catalogDtoToModelDefinition(
  dto: OpenRouterModel,
  envelopeObservedAt?: number
): ModelDefinition {
  const releasedAt =
    catalogTimestampToMs(dto.released) ?? catalogTimestampToMs(dto.created);
  const deprecatedAt = catalogTimestampToMs(dto.deprecated_at);
  const observations = catalogObservations(dto.observations);
  const catalogObservedAt =
    catalogTimestampToMs(dto.catalog_observed_at) ?? envelopeObservedAt;
  return {
    id: dto.id,
    name: dto.name || dto.id,
    provider: providerFromCanonicalId(dto.id),
    hosted: true,
    guestAllowed: dto.guestAllowed,
    contextLength: dto.context_length ?? undefined,
    // Carried so the chat path can ask the catalog whether a model takes
    // `temperature` instead of inferring it from the id alone.
    ...(dto.supported_parameters?.length
      ? { supportedParameters: dto.supported_parameters }
      : {}),
    ...(dto.supported_parameters_complete === true
      ? { supportedParametersComplete: true }
      : {}),
    ...(releasedAt !== undefined ? { releasedAt } : {}),
    ...(deprecatedAt !== undefined ? { deprecatedAt } : {}),
    ...(observations ? { observations } : {}),
    ...(typeof dto.free_tier_eligible === "boolean"
      ? { freeTierEligible: dto.free_tier_eligible }
      : {}),
    ...(typeof dto.judge_eligible === "boolean"
      ? { judgeEligible: dto.judge_eligible }
      : {}),
    ...(catalogObservedAt !== undefined ? { catalogObservedAt } : {}),
  };
}

/** Hosted models from the checked-in snapshot seed — the offline/guest floor. */
function staticHostedFallback(): ModelDefinition[] {
  return hostedModelDefinitionsFromSnapshot();
}

function loadCachedCatalog(): ModelDefinition[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed as ModelDefinition[];
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedCatalog(models: ModelDefinition[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
  } catch {
    // A full/blocked quota must not break the picker — it just loses the
    // offline cache for next load.
  }
}

/** Last-good hosted models when a live fetch isn't available. */
function fallbackModels(): ModelDefinition[] {
  return loadCachedCatalog() ?? staticHostedFallback();
}

function reportDegradation(reason: string): void {
  console.warn("[hosted-model-catalog] client catalog degraded", { reason });
  try {
    track("hosted_model_catalog_degraded", {
      location: "hosted_model_catalog",
      reason,
    });
  } catch {
    // Telemetry must never affect catalog loading.
  }
}

// Module-level memo so every picker instance shares a single fetch per load.
let cached: { status: "live" | "fallback"; models: ModelDefinition[] } | null =
  null;
let inflight: Promise<void> | null = null;
// Bumped on reset so a fetch started before a reset can't write `cached` after
// it (keeps test cases isolated).
let generation = 0;

/** Test hook — reset the module-level memo between cases. */
export function resetHostedModelCatalogForTests(): void {
  cached = null;
  inflight = null;
  generation++;
}

async function fetchCatalogModels(): Promise<ModelDefinition[] | null> {
  try {
    // Public proxy — no Authorization header needed (or forwarded).
    const response = await fetch("/api/mcp/models", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      reportDegradation(`http_${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      ok?: boolean;
      data?: OpenRouterModel[];
      catalog_observed_at?: number | null;
    };
    // The catalog always lists every allowed model, so `ok:false` or an empty
    // array is an implausible/failed fetch, not an authoritative empty catalog.
    if (!data?.ok || !Array.isArray(data.data) || data.data.length === 0) {
      reportDegradation("empty_or_error_payload");
      return null;
    }
    // The observation time may ride on the envelope instead of every row.
    const envelopeObservedAt = catalogTimestampToMs(data.catalog_observed_at);
    return data.data.map((dto) =>
      catalogDtoToModelDefinition(dto, envelopeObservedAt)
    );
  } catch (error) {
    reportDegradation(
      error instanceof Error ? `threw_${error.name}` : "threw_unknown"
    );
    return null;
  }
}

export function useHostedModelCatalog(): HostedModelCatalogState {
  const [state, setState] = useState<HostedModelCatalogState>(() =>
    cached
      ? { status: cached.status, hostedCatalog: cached.models }
      : { status: "loading", hostedCatalog: fallbackModels() }
  );

  useEffect(() => {
    // A `live` cache is authoritative and shared across picker instances. A
    // `fallback` cache is an offline artifact — do NOT reuse it, or a client
    // that first loaded offline stays pinned to the static fallback forever;
    // fall through and re-attempt the (public) catalog fetch.
    if (cached?.status === "live") {
      setState({ status: cached.status, hostedCatalog: cached.models });
      return;
    }

    let mounted = true;
    const effectGeneration = generation;

    if (!inflight) {
      inflight = fetchCatalogModels()
        .then((models) => {
          if (effectGeneration !== generation) return;
          if (models) {
            saveCachedCatalog(models);
            cached = { status: "live", models };
          } else {
            cached = { status: "fallback", models: fallbackModels() };
          }
        })
        .finally(() => {
          inflight = null;
        });
    }

    void inflight.then(() => {
      if (mounted && effectGeneration === generation && cached) {
        setState({ status: cached.status, hostedCatalog: cached.models });
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
