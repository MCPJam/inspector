import type { LeadModelProviderHint } from "@/lib/selected-model-storage";

/** The fields selection resolution reads. Structural so it accepts a
 *  `ModelDefinition` without importing the whole shared type graph. */
type SelectableModel = { id: unknown; provider: string; hosted?: boolean };

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

/**
 * Which of two same-id rows a saved conversation ran on, from its
 * `modelSource`.
 *
 * `mcpjam` is a turn billed to MCPJam credits — the hosted row. `byok` and
 * `local_byok` are the user's or org's own key — the "Your providers" row.
 * Anything else (`external-account`, absent, a value this client predates)
 * says nothing about the collision, so it is `undefined`.
 */
function hostedFromModelSource(modelSource: string | undefined) {
  if (modelSource === "mcpjam") return true;
  if (modelSource === "byok" || modelSource === "local_byok") return false;
  return undefined;
}

/**
 * Resolve the model a saved conversation should reopen on.
 *
 * Restoring a history thread looked its model up by id alone, so a thread
 * that ran on the user's OpenRouter key reopened on the hosted row sharing its
 * id — and its next turn was billed to MCPJam (#5472). History rows record
 * `modelSource`, which is exactly the hosted-versus-own-key distinction the
 * collision is about, so it decides between them.
 *
 * Hosted rows are the ones not stamped `hosted: false`; every own-provider row
 * the picker builds is stamped. With no usable `modelSource`, the first id
 * match — the behaviour before this existed.
 */
export function resolveRestoredModel<T extends SelectableModel>(
  models: readonly T[],
  modelId: string | null | undefined,
  modelSource: string | undefined,
): T | null {
  if (!modelId) return null;
  const matches = models.filter((model) => String(model.id) === modelId);
  const wantHosted = hostedFromModelSource(modelSource);
  if (wantHosted !== undefined) {
    const preferred = matches.find(
      (model) => (model.hosted !== false) === wantHosted,
    );
    if (preferred) return preferred;
  }
  return matches[0] ?? null;
}
