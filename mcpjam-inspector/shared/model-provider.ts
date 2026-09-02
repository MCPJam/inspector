/**
 * CANONICAL provider classification for a model id.
 *
 * One question — "given only this string, which provider serves it?" — asked in
 * at least five places that used to each answer it slightly differently: the
 * synthetic model builder (`server/utils/org-model-config.ts`), the chat
 * session's locked-model fallback (`client/src/hooks/use-chat-session.ts`), the
 * public eval API's `deriveProvider` (`server/routes/v1/evals.ts`), and the
 * backend's eval projection mirror (`convex/lib/modelProviderClassification.ts`
 * in mcpjam-backend). The divergences were real bugs: `meta-llama/...` came back
 * as provider `meta-llama` from one and `meta` from another; `mistralai/...`
 * fell all the way through to Ollama; a bare unknown id became `openrouter` in
 * chat and `ollama` in the runner.
 *
 * THIS MODULE IS THE SOURCE OF TRUTH. The backend mirror is a hand-kept copy
 * (Convex cannot import from this repo) checked against the SAME fixture
 * vectors — see `__tests__/model-provider.test.ts` here and
 * `convex/lib/__tests__/modelProviderClassification.test.ts` there. Change the
 * rules in one and the other's parity test fails.
 *
 * PURE: no catalog lookup, no network, no node builtins. Inspector's
 * `buildSyntheticModelDefinition` layers an exact-catalog hit ON TOP of this
 * (a catalog entry carries contextLength and a curated display name that no
 * amount of string parsing can recover); the backend has no such catalog and
 * uses the classification directly.
 */

import { isBedrockModelId, type ModelProvider } from "./types";

/**
 * `<prefix>/<model>` → provider, for the prefixes that are NOT already the
 * provider name. Mirrors the catalog entries in `SUPPORTED_MODELS`.
 *
 * Kept separate from the identity entries below so "which of these is an
 * alias?" is answerable by reading, and so a new alias cannot be mistaken for a
 * new provider.
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

/** `<prefix>/<model>` where the prefix IS the provider name. */
const MODEL_ID_PREFIX_IDENTITY = [
  "anthropic",
  "azure",
  "bedrock",
  "deepseek",
  "google",
  "minimax",
  "moonshotai",
  "openai",
  "ollama",
  "openrouter",
  "qwen",
  "mistral",
  "z-ai",
] as const satisfies readonly ModelProvider[];

/**
 * Every recognized `<prefix>/` → provider mapping, aliases included. Exported
 * because the backend mirror's parity test asserts key-for-key equality.
 */
export const MODEL_ID_PREFIX_TO_PROVIDER: Record<string, ModelProvider> =
  Object.assign(
    Object.create(null) as Record<string, ModelProvider>,
    Object.fromEntries(MODEL_ID_PREFIX_IDENTITY.map((p) => [p, p])),
    MODEL_ID_PREFIX_ALIASES
  );

export type ModelProviderClassification = {
  provider: ModelProvider;
  /**
   * Set only for `provider: "custom"` — the org-provider slug parsed out of a
   * `custom:<slug>:<model>` id. Never an empty string (an id of exactly
   * `custom:` classifies as custom with the field absent).
   */
  customProviderName?: string;
};

/**
 * Classify a model id, in this order:
 *
 *   1. Trim. An empty or whitespace-only id has no provider — `null`, never a
 *      guess. (This is the guard that keeps an unpinned host's persisted `""`
 *      from silently becoming an Ollama BYOK model.)
 *   2. `custom:<slug>:<model>` / `custom:<slug>/<model>` → `custom`, slug
 *      carried on `customProviderName`.
 *   3. A recognized `<prefix>/` (including the aliases above).
 *   4. An unprefixed Bedrock-shaped id (org Bedrock models surface bare
 *      inference-profile ids, and Bedrock ARNs are bare too).
 *   5. Everything else → `ollama`. Bare ids are how Ollama BYOK models are
 *      stored, no catalog id is bare, and this is the long-standing
 *      synthetic-runtime behavior that the rest of the resolver chain is
 *      built around.
 *
 * Note that step 5 makes this total for every non-blank input: callers that
 * need "I could not tell" must check for a blank id, which is exactly the one
 * case that returns `null`.
 */
export function classifyModelIdProvider(
  modelId: string
): ModelProviderClassification | null {
  const id = modelId.trim();
  if (id.length === 0) return null;

  if (id.startsWith("custom:")) {
    // Picker-minted ids are `custom:<slug>:<modelId>` (both the local and org
    // builders in model-helpers use a colon; the evals runner parses the same
    // way); tolerate `custom:<slug>/<modelId>` too. The slug is the segment
    // before the first `:` or `/`.
    const slug = id.slice("custom:".length).split(/[:/]/, 1)[0];
    return {
      provider: "custom",
      ...(slug ? { customProviderName: slug } : {}),
    };
  }

  const slashIdx = id.indexOf("/");
  if (slashIdx > 0) {
    // `hasOwnProperty`, not a bare index, for `"constructor/x"` and
    // `"toString/x"`. The map above is built on a NULL prototype, so those
    // already read as `undefined` here — this is the belt to that braces, and
    // it is what makes the lookup safe on its own terms rather than by way of
    // one `Object.create(null)` twenty lines up. The backend mirror of this
    // function is the reason that matters: it is hand-kept, and a copy that
    // reconstructs the map as an ordinary object literal would otherwise read a
    // FUNCTION off `Object.prototype` and — being truthy — return it as the
    // provider, which then flows into provider dispatch as a non-string.
    const prefix = id.slice(0, slashIdx);
    if (
      Object.prototype.hasOwnProperty.call(MODEL_ID_PREFIX_TO_PROVIDER, prefix)
    ) {
      return { provider: MODEL_ID_PREFIX_TO_PROVIDER[prefix]! };
    }
  }

  if (isBedrockModelId(id)) return { provider: "bedrock" };

  return { provider: "ollama" };
}

/**
 * {@link classifyModelIdProvider} reduced to the provider name, for callers
 * that only need the string. `null` for a blank id, same contract.
 */
export function providerForModelId(modelId: string): ModelProvider | null {
  return classifyModelIdProvider(modelId)?.provider ?? null;
}
