import type { LeadModelProviderHint } from "@/lib/selected-model-storage";

/** The two fields selection resolution reads. Structural so it accepts a
 *  `ModelDefinition` without importing the whole shared type graph. */
type SelectableModel = { id: unknown; provider: string };

/**
 * Resolve a persisted model id back to one row of the available models.
 *
 * An id is not unique across providers. OpenRouter ids share MCPJam's hosted
 * namespace exactly, so `anthropic/claude-sonnet-5` can appear twice in the
 * list: the hosted row first, then the "Your providers → OpenRouter" row. An
 * id-only `find` always returned the hosted one, and the request that followed
 * went to MCPJam credits instead of the user's own key (#5472).
 *
 * `hint` is the provider the id was picked under. It is honoured only when it
 * qualifies this exact id, and only when a row with that provider is still
 * available; otherwise resolution falls back to the id-only match, which is
 * the behaviour every persisted selection had before the hint existed.
 *
 * `isEligible` narrows both passes, so a hint cannot resurrect a row the
 * caller has ruled out (a disabled model, say).
 */
export function resolveModelSelection<T extends SelectableModel>(
  models: readonly T[],
  modelId: string | null | undefined,
  hint: LeadModelProviderHint | null,
  isEligible: (model: T) => boolean = () => true,
): T | null {
  if (!modelId) return null;

  const matchesId = (model: T) => String(model.id) === modelId;

  if (hint && hint.modelId === modelId) {
    const hinted = models.find(
      (model) =>
        matchesId(model) && model.provider === hint.provider && isEligible(model),
    );
    if (hinted) return hinted;
  }

  return models.find((model) => matchesId(model) && isEligible(model)) ?? null;
}
