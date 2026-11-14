/**
 * The canonical `provider/model` id for a model a provider names by its own
 * (native) id: `gpt-5.1` on OpenAI, `claude-sonnet-4-5` on Anthropic, a
 * Bedrock model id, a model an organization lists for Moonshot.
 *
 * A saved selection stores the canonical id and, beside it, the native id the
 * provider is called with (`nativeModelId`), so execution never depends on
 * the canonical spelling. The canonical id still should match the hosted
 * catalog where the catalog lists the model: catalog evidence (capabilities)
 * is looked up by it. The answer is, in order:
 *
 *  1. a reviewed exception, for a provider whose API spelling differs from
 *     the catalog's (Anthropic's dashed `claude-sonnet-4-5` is the catalog's
 *     `anthropic/claude-sonnet-4.5`);
 *  2. the catalog's own entry, when it lists exactly `<vendor>/<native>`
 *     under that provider (`grok-4.5` → `spacexai/grok-4.5`);
 *  3. otherwise the provider's canonical vendor prefix and the native id
 *     (`gpt-5.1` → `openai/gpt-5.1`, `bedrock/<model id>`).
 *
 * Pure and browser-safe.
 */
import { ANTHROPIC_NATIVE_MODEL_IDS } from "@mcpjam/sdk/browser";
import { getCanonicalModelId } from "./types";

/** A lowercase provider segment, as the selection validator requires. */
export const PROVIDER_SEGMENT = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * Canonical vendor prefix for a provider key / Gateway spelling. Keys not
 * listed are already canonical (`openai`, `anthropic`, `ollama`, …). The
 * backend refuses the Gateway spellings (`xai/`, `mistral/`), so every
 * derived id goes through this.
 */
const CANONICAL_PROVIDER_PREFIX: Readonly<Record<string, string>> = {
  xai: "x-ai",
  zai: "z-ai",
  meta: "meta-llama",
  mistral: "mistralai",
  alibaba: "qwen",
};

/** The canonical vendor prefix for a provider key (`xai` → `x-ai`). */
export function canonicalPrefix(prefix: string): string {
  return Object.prototype.hasOwnProperty.call(CANONICAL_PROVIDER_PREFIX, prefix)
    ? CANONICAL_PROVIDER_PREFIX[prefix]!
    : prefix;
}

/** Reviewed exceptions by provider key: native id or alias → canonical id. */
const EXCEPTIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "anthropic",
    new Map(
      ANTHROPIC_NATIVE_MODEL_IDS.flatMap((row) =>
        [row.nativeId, ...(row.nativeAliases ?? [])].map(
          (native) => [native, row.canonicalId] as const,
        ),
      ),
    ),
  ],
]);

/**
 * The canonical id of `nativeId` on `provider` (see the module comment), or
 * `null` when the provider key can't be a canonical prefix or the id is
 * blank. `nativeId` is the provider's own id, never a `vendor/model` id.
 */
export function canonicalModelIdForNative(
  provider: string,
  nativeId: string,
): string | null {
  const id = nativeId.trim();
  const key = provider.trim().toLowerCase();
  if (!id || !PROVIDER_SEGMENT.test(key)) return null;
  const exception = EXCEPTIONS.get(key)?.get(id);
  if (exception) return exception;
  const known = getCanonicalModelId(id, key);
  const slash = known.indexOf("/");
  if (slash > 0 && known.slice(slash + 1) === id) {
    return `${canonicalPrefix(known.slice(0, slash))}/${id}`;
  }
  return `${canonicalPrefix(key)}/${id}`;
}
