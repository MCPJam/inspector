/**
 * Reasoning effort on a chat turn (Playground `chat-v2`, both the web and the
 * MCP route).
 *
 * The one non-saved carrier of an effort is a top-level `reasoningEffort` in
 * the request body. A selected host may also carry a saved effort on its
 * `modelSelection.settings`; that selection belongs to ONE model, so it only
 * applies when the turn runs that same model (`selectionIfMatches`).
 *
 * Precedence, per turn:
 *   - a host-wins turn (a scenario / share link, whose body the visitor owns):
 *     the host's saved effort only; the body's is ignored.
 *   - otherwise: the body's effort, else the host's saved one.
 *
 * "Refuse, never drop": every route either applies the effort or refuses it
 * before spend. The hosted `/stream` and org-cloud rails receive it as a
 * top-level field (which the backend prefers over a selection's), the direct
 * rails apply it as provider options here, and a harness turn hands it to its
 * adapter (whose declared efforts decide).
 */
import {
  MODEL_REASONING_EFFORTS,
  reasoningEffortProviderOptions,
  selectionIfMatches,
  type ModelReasoningEffort,
  type ModelSelection,
} from "@mcpjam/sdk/browser";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

export type ChatReasoningEffortParse =
  | { ok: true; effort?: ModelReasoningEffort }
  | { ok: false; error: string };

/**
 * Read the top-level body field. Absent (or `null`) is "no effort"; a value
 * that is not one of the SDK's levels is a validation error, never quietly
 * treated as absent (that would drop what the caller asked for).
 */
export function parseChatReasoningEffort(
  raw: unknown,
): ChatReasoningEffortParse {
  if (raw === undefined || raw === null) return { ok: true };
  if (
    typeof raw === "string" &&
    (MODEL_REASONING_EFFORTS as readonly string[]).includes(raw)
  ) {
    return { ok: true, effort: raw as ModelReasoningEffort };
  }
  return {
    ok: false,
    error: `reasoningEffort must be one of: ${MODEL_REASONING_EFFORTS.join(", ")}`,
  };
}

/** The host's saved selection, only if it is for the model this turn runs. */
export function hostSelectionForTurn(
  hostSelection: ModelSelection | undefined,
  turnModelId: string,
): ModelSelection | undefined {
  return selectionIfMatches(hostSelection, turnModelId);
}

/** The effort this turn runs at, or `undefined`. See the module doc. */
export function resolveChatReasoningEffort(args: {
  bodyEffort?: ModelReasoningEffort;
  /** The host's selection ALREADY narrowed to this turn's model. */
  hostSelection?: ModelSelection;
  /** A scenario / share-link turn: the host's value wins, the body's is ignored. */
  hostWins: boolean;
}): ModelReasoningEffort | undefined {
  const saved = args.hostSelection?.settings?.reasoningEffort;
  return args.hostWins ? saved : (args.bodyEffort ?? saved);
}

export type DirectChatEffort =
  | { ok: true; providerOptions?: ProviderOptions }
  | { ok: false; reason: string };

/**
 * Apply an effort on a DIRECT route (the inspector calls the provider itself).
 *
 * Refused when the provider/model has no effort control the installed AI SDK
 * provider exposes, and when the caller ALSO asked for an explicit
 * temperature: reasoning providers reject or ignore sampling temperature, so
 * the two cannot both be honoured. (A host DEFAULT temperature is not a
 * request: the resolved temperature is omitted under an effort instead.)
 */
export function directChatEffort(args: {
  providerKey: string;
  modelId: string;
  effort?: ModelReasoningEffort;
  /** A temperature the caller explicitly sent (not a host default). */
  explicitTemperature?: number;
}): DirectChatEffort {
  if (args.effort === undefined) return { ok: true };
  if (args.explicitTemperature !== undefined) {
    return {
      ok: false,
      reason: `a temperature (${args.explicitTemperature}) and a reasoning effort ("${args.effort}") cannot both be applied to ${args.modelId}; keep one`,
    };
  }
  const providerOptions = reasoningEffortProviderOptions({
    providerKey: args.providerKey,
    modelId: args.modelId,
    effort: args.effort,
  });
  if (!providerOptions) {
    return {
      ok: false,
      reason: `reasoning effort "${args.effort}" is not supported for ${args.modelId} on the ${args.providerKey} provider`,
    };
  }
  return { ok: true, providerOptions: providerOptions as ProviderOptions };
}
