import {
  extractReportedProviderCost,
  normalizeModelUsage,
  priceModelCall,
  toModelCallCostEvidence,
  type ModelCallCostEvidence,
  type RateEvidence,
} from "@mcpjam/sdk";
import { getByokProviderAdapter } from "../byok/providers/index.js";
import { getListPrices } from "./list-price-catalog.js";
import { localRateOverrides } from "./local-rate-overrides.js";
import { waitAtMost } from "./wait-at-most.js";

/** One provider call as the AI SDK reports a finished step. */
export type StepCall = { usage: unknown; providerMetadata: unknown };

/** Resolves to the call's evidence; never rejects and never waits long. */
export type StepCallPricer = (call: StepCall) => Promise<ModelCallCostEvidence>;

/**
 * Providers with a reviewed native-to-canonical model table (see
 * `utils/byok/`), so a call's model is provably the one a list price is
 * published for. A router (OpenRouter), a cloud deployment (Azure, Bedrock)
 * or a local model (Ollama, custom) can serve anything under any name: those
 * calls are priced from reported dollars or a rate the person entered.
 */
const LIST_PRICED_PROVIDERS = new Set(["anthropic", "openai", "google"]);

/**
 * How long a finished step waits for its rate. The lookup starts with the
 * turn, so it is normally ready; past this the call is recorded unpriced
 * rather than holding the next step.
 */
const RATE_WAIT_MS = 2_000;

/** The canonical id a list price would be published under, if any. */
export function listPriceModelId(
  providerKey: string,
  modelId: string,
): string | undefined {
  if (!LIST_PRICED_PROVIDERS.has(providerKey)) return undefined;
  const adapter = getByokProviderAdapter(providerKey);
  if (!adapter) return undefined;
  const canonical = adapter.toCanonicalId(modelId);
  if (canonical) return canonical;
  return adapter.toNativeId(modelId).ok ? modelId : undefined;
}

/**
 * Prices each call a personal key makes, once, when its step finishes:
 * dollars the provider reported, else a local override in force at the
 * call's time, else the public list price for the same model. Anything else
 * is recorded as unavailable with its reason, never as $0.
 */
export function createDirectCallPricer(args: {
  providerKey: string;
  modelId: string;
  now?: () => number;
}): StepCallPricer {
  const { providerKey, modelId } = args;
  const now = args.now ?? Date.now;
  const canonicalId = listPriceModelId(providerKey, modelId);
  // Started with the turn so the fetch overlaps the model call.
  const listPrices = canonicalId ? getListPrices() : undefined;

  async function rateAt(at: number): Promise<RateEvidence | undefined> {
    const override = await localRateOverrides.rateFor({
      providerKey,
      modelIds: canonicalId ? [modelId, canonicalId] : [modelId],
      at,
    });
    if (override) return override;
    return canonicalId ? (await listPrices)?.get(canonicalId) : undefined;
  }

  return async ({ usage: rawUsage, providerMetadata }) => {
    const usage = normalizeModelUsage(rawUsage);
    const reported = extractReportedProviderCost(providerMetadata);
    const recordedAt = now();
    const rate = reported
      ? undefined
      : await waitAtMost(rateAt(recordedAt), RATE_WAIT_MS, "rate lookup");
    return toModelCallCostEvidence(priceModelCall({ usage, reported, rate }), {
      usage,
      usageSource: "provider",
      funding: "customer",
      recordedAt,
    });
  };
}
