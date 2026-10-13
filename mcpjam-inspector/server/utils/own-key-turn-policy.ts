/**
 * "Use your keys for all AI features" for a chat turn that runs on a key this
 * process holds: the request's own key, a local provider such as Ollama, or a
 * custom endpoint.
 *
 * Such a turn calls the provider from this process and never reaches the
 * backend, so the backend cannot refuse it, and the model picker is not a
 * guard. A local process or a personal key is no exemption from the policy,
 * so the turn reads it here the way an eval run on its own keys does
 * (`orgPolicyConfigForClientKeys`). While the organization that owns the
 * project requires its own keys, the turn is refused before anything reaches
 * the provider:
 * - a saved selection goes through `resolveLocalModelSelection` with
 *   `requireOrgKeys`, as an eval case's does (`resolveEvalSelectionRoute`);
 * - a turn with no saved selection, or a legacy one, also runs on a key on
 *   this machine and gets the same `org_keys_required` refusal.
 *
 * A turn with no project, or a build with no backend to ask, runs as before.
 * A policy read that fails refuses the turn as retryable
 * `ai_key_policy_unavailable`.
 */
import { wrapLanguageModel, type LanguageModel } from "ai";
import { isLegacySelection, type RequestedModelSelection } from "@mcpjam/sdk";
import { WebRouteError } from "../routes/web/errors.js";
import { orgPolicyConfigForClientKeys } from "../services/evals/org-policy-client-keys.js";
import { asAiRefusalRouteError } from "./ai-refusal-route-error.js";
import {
  ModelResolutionRefusalError,
  ORG_KEYS_REQUIRED_REASON,
  resolveLocalModelSelection,
  type ModelRefusal,
} from "./model-resolution-local.js";
import type {
  ResolveOrgModelConfigAuth,
  ResolvedOrgModelConfig,
} from "./org-model-config.js";

export type OwnKeyTurn = {
  projectId: string | undefined;
  /** The turn's saved selection, when it has one. */
  selection: RequestedModelSelection | undefined;
  /** The provider the turn's model runs on (`ollama`, `custom`, ...). */
  provider: string;
  /** Whether the request carries its own key. */
  hasRequestKey: boolean;
  auth: ResolveOrgModelConfigAuth;
};

/**
 * The route error to answer instead of running the turn, or `undefined` when
 * the turn may run on its own key.
 */
export async function ownKeyTurnRefusal(
  turn: OwnKeyTurn,
): Promise<WebRouteError | undefined> {
  if (!turn.projectId) return undefined;
  let orgConfig: ResolvedOrgModelConfig | undefined;
  try {
    orgConfig = await orgPolicyConfigForClientKeys(
      { projectId: turn.projectId },
      turn.auth,
    );
  } catch (error) {
    // The policy could not be read: fail closed with its retryable answer.
    if (error instanceof WebRouteError) return error;
    throw error;
  }
  // Set only while the organization requires its own keys.
  if (!orgConfig) return undefined;
  const refusal = new ModelResolutionRefusalError(
    ownKeyRefusals(turn, orgConfig),
  );
  return asAiRefusalRouteError(refusal) ?? undefined;
}

function ownKeyRefusals(
  turn: OwnKeyTurn,
  orgConfig: ResolvedOrgModelConfig,
): ModelRefusal[] {
  const { selection } = turn;
  if (selection && !isLegacySelection(selection)) {
    const result = resolveLocalModelSelection({
      selection,
      purpose: "chat",
      hasOrgTarget: true,
      orgProviders: orgConfig.providers,
      hasLocalKey: () => turn.hasRequestKey,
      requireOrgKeys: true,
    });
    if (!result.ok) return result.refusals;
  }
  // No saved selection (or one the resolver let through): the turn is still
  // about to run on a key on this machine.
  return [
    {
      code: "org_keys_required",
      reason: ORG_KEYS_REQUIRED_REASON,
      evidence: { rail: "direct", provider: turn.provider },
    },
  ];
}

/**
 * How long a turn trusts the policy answer it last read before a provider
 * request reads it again. A self-hosted Inspector reads the policy from the
 * backend's bearer-only route, which allows each user 60 reads a minute.
 * Reading before every tool-loop step spent that budget on a single
 * multi-model turn, and the next read's 429 refused the turn as
 * `ai_key_policy_unavailable`.
 */
export const OWN_KEY_POLICY_RECHECK_MS = 15_000;

/**
 * Re-read the policy before a retry or tool-loop provider request, at most
 * once per `OWN_KEY_POLICY_RECHECK_MS`, so a policy change still reaches a
 * running turn within seconds.
 */
export function withOwnKeyTurnPolicy(model: LanguageModel, turn: OwnKeyTurn) {
  if (typeof model === "string") {
    throw new Error("A local model must be an explicit provider model.");
  }
  let allowedAt: number | undefined;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => {
        if (
          allowedAt !== undefined &&
          Date.now() - allowedAt < OWN_KEY_POLICY_RECHECK_MS
        ) {
          return params;
        }
        const refusal = await ownKeyTurnRefusal(turn);
        if (refusal) throw refusal;
        allowedAt = Date.now();
        return params;
      },
    },
  });
}
