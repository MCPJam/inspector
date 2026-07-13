import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { track } from "@/lib/analytics";
import {
  SUPPORTED_MODELS,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
  type ModelDefinition,
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
 * A guest (or offline/Electron) can't reach the auth-gated `/models` route, so
 * those cases resolve to `fallback` off the cache/static list rather than an
 * error. The org-config precedence path is unaffected — this only supplies the
 * hosted ("free") source that composition unions with BYOK/org models.
 */

const STORAGE_KEY = "mcpjam.hostedModelCatalog.v1";

export type HostedCatalogStatus = "loading" | "live" | "fallback";

export interface HostedModelCatalogState {
  hostedCatalog: ModelDefinition[];
  status: HostedCatalogStatus;
}

// Catalog id prefixes whose logo/display live under a different provider key.
const PROVIDER_ALIASES: Record<string, string> = {
  "meta-llama": "meta",
  "x-ai": "xai",
  mistralai: "mistral",
};

/**
 * Derive the provider key from a canonical (slash-prefixed) catalog id. The
 * catalog carries no `provider` field; the id prefix is the source of truth
 * (e.g. "anthropic/claude-haiku-4.5" → "anthropic"). Unknown prefixes are
 * returned verbatim — the picker renders them with a monogram + title-cased
 * name, so a brand-new provider needs no code change.
 */
export function providerFromCanonicalId(id: string): string {
  const slash = id.indexOf("/");
  const prefix = (slash > 0 ? id.slice(0, slash) : id).toLowerCase();
  return PROVIDER_ALIASES[prefix] ?? prefix;
}

function catalogDtoToModelDefinition(dto: OpenRouterModel): ModelDefinition {
  return {
    id: dto.id,
    name: dto.name || dto.id,
    provider: providerFromCanonicalId(dto.id),
    hosted: true,
    guestAllowed: dto.guestAllowed,
    contextLength: dto.context_length ?? undefined,
  };
}

/** The pre-catalog behavior: the static hosted subset, tagged `hosted`. */
function staticHostedFallback(): ModelDefinition[] {
  return SUPPORTED_MODELS.filter((model) =>
    isMCPJamProvidedModel(String(model.id))
  ).map((model) => ({
    ...model,
    hosted: true,
    guestAllowed: isMCPJamGuestAllowedModel(String(model.id)),
  }));
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

async function fetchCatalogModels(
  getAccessToken: () => Promise<string | undefined>
): Promise<ModelDefinition[] | null> {
  try {
    const accessToken = await getAccessToken();
    const response = await fetch("/api/mcp/models", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) {
      reportDegradation(`http_${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      ok?: boolean;
      data?: OpenRouterModel[];
    };
    // The catalog always lists every allowed model, so `ok:false` or an empty
    // array is an implausible/failed fetch, not an authoritative empty catalog.
    if (!data?.ok || !Array.isArray(data.data) || data.data.length === 0) {
      reportDegradation("empty_or_error_payload");
      return null;
    }
    return data.data.map(catalogDtoToModelDefinition);
  } catch (error) {
    reportDegradation(
      error instanceof Error ? `threw_${error.name}` : "threw_unknown"
    );
    return null;
  }
}

export function useHostedModelCatalog(): HostedModelCatalogState {
  const { isAuthenticated } = useConvexAuth();
  const { getAccessToken } = useAuth();

  const [state, setState] = useState<HostedModelCatalogState>(() =>
    cached
      ? { status: cached.status, hostedCatalog: cached.models }
      : { status: "loading", hostedCatalog: fallbackModels() }
  );

  useEffect(() => {
    // The `/models` route is auth-gated: a guest (or offline/Electron) can't
    // fetch it, so resolve straight to the cached/static fallback.
    if (!isAuthenticated) {
      const models = fallbackModels();
      cached = { status: "fallback", models };
      setState({ status: "fallback", hostedCatalog: models });
      return;
    }

    // Authenticated: a `live` cache is authoritative and shared across picker
    // instances. A `fallback` cache is a guest/offline artifact — do NOT reuse
    // it here, or a guest who signs in stays pinned to the static fallback
    // forever; fall through and fetch the now-reachable auth-gated catalog.
    if (cached?.status === "live") {
      setState({ status: cached.status, hostedCatalog: cached.models });
      return;
    }

    let mounted = true;
    const effectGeneration = generation;

    if (!inflight) {
      inflight = fetchCatalogModels(getAccessToken)
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
  }, [isAuthenticated, getAccessToken]);

  return state;
}
