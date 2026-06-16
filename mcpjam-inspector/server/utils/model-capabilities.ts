/**
 * model-capabilities.ts — capability-based Computer Use eligibility for any
 * driver model.
 *
 * The wire-format `computer` tool (see computer-use-tool.ts) is an ordinary
 * function tool — nothing about it is provider-specific. What a model actually
 * needs to drive it is (a) tool calling and (b) vision, since every action
 * result returns a screenshot as image content. So eligibility is a capability
 * check, not a provider check:
 *
 *   1. Mapped Claude ids resolve offline via COMPUTER_USE_TOOL_VERSIONS — no
 *      network, deterministic, and covers direct-Anthropic (BYOK) ids that
 *      don't exist in the OpenRouter catalog under that exact key.
 *   2. Everything else is looked up in OpenRouter's PUBLIC model catalog
 *      (`/api/v1/models`, no API key), keyed by the OpenRouter id the product
 *      already uses as its model id (`openai/gpt-5`, `google/gemini-2.5-pro`,
 *      …). Eligible iff `architecture.input_modalities` includes "image" AND
 *      `supported_parameters` includes "tools". Because the endpoint is
 *      unauthenticated this works identically for MCPJam-credit and BYOK runs.
 *
 * Failure semantics are deliberately conservative: if the catalog is
 * unreachable or the id is unknown, a non-Claude model gets NO computer tools
 * — exactly the pre-feature behavior. Claude models never depend on the
 * network. The catalog is cached in-process (TTL + in-flight dedup + stale
 * fallback) so one fetch serves many eval iterations.
 */

import { resolveComputerUseToolVersion } from "./computer-use-tool";
import { logger } from "./logger";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000; // refresh hourly
const FAILURE_RETRY_MS = 60 * 1000; // don't hammer OpenRouter after a failure
const FETCH_TIMEOUT_MS = 10_000;

interface CatalogCapabilities {
  vision: boolean;
  tools: boolean;
}

let catalog: Map<string, CatalogCapabilities> | null = null;
let catalogFetchedAt = 0;
let lastFetchFailureAt = 0;
let inFlight: Promise<Map<string, CatalogCapabilities> | null> | null = null;

/** Raw model id (no normalization beyond trim/lowercase — OpenRouter ids are
 *  matched verbatim, dots and provider prefix included). */
function rawModelId(
  model: string | { id?: string; modelId?: string } | null | undefined
): string | undefined {
  const raw =
    typeof model === "string"
      ? model
      : model?.id ?? model?.modelId ?? undefined;
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

async function fetchCatalog(): Promise<Map<
  string,
  CatalogCapabilities
> | null> {
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn("[model-capabilities] OpenRouter catalog fetch failed", {
        status: res.status,
      });
      return null;
    }
    const body = (await res.json()) as {
      data?: Array<{
        id?: string;
        architecture?: { input_modalities?: string[] };
        supported_parameters?: string[];
      }>;
    };
    if (!Array.isArray(body.data)) {
      logger.warn(
        "[model-capabilities] OpenRouter catalog response missing data array"
      );
      return null;
    }
    const next = new Map<string, CatalogCapabilities>();
    for (const entry of body.data) {
      if (typeof entry?.id !== "string" || !entry.id) continue;
      next.set(entry.id.toLowerCase(), {
        vision:
          entry.architecture?.input_modalities?.includes("image") ?? false,
        tools: entry.supported_parameters?.includes("tools") ?? false,
      });
    }
    logger.debug("[model-capabilities] OpenRouter catalog refreshed", {
      models: next.size,
    });
    return next;
  } catch (err) {
    logger.warn("[model-capabilities] OpenRouter catalog fetch threw", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function getCatalog(): Promise<Map<string, CatalogCapabilities> | null> {
  const now = Date.now();
  if (catalog && now - catalogFetchedAt < CATALOG_TTL_MS) return catalog;
  if (inFlight) return inFlight;
  // Back off after a failure; serve the stale catalog (or null) meanwhile.
  if (now - lastFetchFailureAt < FAILURE_RETRY_MS) return catalog;
  inFlight = fetchCatalog().then((fresh) => {
    inFlight = null;
    if (fresh) {
      catalog = fresh;
      catalogFetchedAt = Date.now();
    } else {
      lastFetchFailureAt = Date.now();
    }
    return catalog;
  });
  return inFlight;
}

/**
 * Whether the driver model can drive the wire-format Computer Use tools:
 * mapped Claude id (offline), or OpenRouter catalog entry with image input +
 * tool calling. Unknown/unreachable resolves to `false` — never advertise a
 * tool the model can't call.
 */
export async function modelSupportsComputerUse(
  model: string | { id?: string; modelId?: string } | null | undefined
): Promise<boolean> {
  if (resolveComputerUseToolVersion(model) !== null) return true;
  const id = rawModelId(model);
  if (!id) return false;
  const entries = await getCatalog();
  const capabilities = entries?.get(id);
  if (!capabilities) {
    logger.debug(
      "[model-capabilities] model not in OpenRouter catalog; Computer Use off",
      { model: id }
    );
    return false;
  }
  return capabilities.vision && capabilities.tools;
}

/** Test hook: clear the module-level catalog cache. */
export function __resetModelCapabilitiesForTests(): void {
  catalog = null;
  catalogFetchedAt = 0;
  lastFetchFailureAt = 0;
  inFlight = null;
}
