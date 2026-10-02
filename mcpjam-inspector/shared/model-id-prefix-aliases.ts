import type { ModelProvider } from "./types";

/**
 * `<prefix>/<model>` → provider, for the canonical id prefixes that are NOT
 * already the provider name. The single table for this question: both
 * `classifyModelIdProvider` (via `model-provider.ts`, which re-exports it) and
 * `hostedProviderFromCanonicalId` in `types.ts` read it.
 *
 * It lives in its own module because `model-provider.ts` imports `types.ts`,
 * and `types.ts` reads this table while it loads (to build its hosted
 * candidates), so the table cannot sit in either one without an import cycle.
 * The only import here is a type, which is erased.
 */
export const MODEL_ID_PREFIX_ALIASES: Record<string, ModelProvider> = {
  "meta-llama": "meta",
  // `mistralai/...` is the OpenRouter/HuggingFace spelling of the same vendor
  // the catalog files under `mistral/...`. Before this map it matched no
  // prefix and fell through to the bare-id Ollama catch-all.
  mistralai: "mistral",
  // The catalog serves the newer Grok models under `spacexai/*`, the same
  // vendor it files older ones under `x-ai/*`. Missing here it fell through to
  // the bare-id Ollama catch-all at the bottom of `classifyModelIdProvider`,
  // so a Grok model classified as Ollama BYOK for provider dispatch and eval
  // model resolution — the `mistralai` failure above, repeated.
  spacexai: "xai",
  "x-ai": "xai",
};
