import type { RequestedModelSelection } from "@mcpjam/sdk";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import { HOSTED_MODE } from "../../config.js";
import {
  createLlmModel,
  type BaseUrls,
  type CustomProviderConfig,
} from "../../utils/chat-helpers.js";
import { directChatEffort } from "../../utils/chat-reasoning-effort.js";
import {
  ownKeyTurnCheck,
  withOwnKeyTurnPolicy,
  type OwnKeyTurn,
} from "../../utils/own-key-turn-policy.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/** Supplied only by local ingress; never a serialized authorization policy. */
export type DirectProviderInput = {
  apiKey?: string;
  baseUrls?: BaseUrls;
  customProviders?: CustomProviderConfig[];
};

export async function prepareDirectProvider(args: {
  input: DirectProviderInput;
  model: ModelDefinition;
  projectId?: string;
  selection?: RequestedModelSelection;
  auth: OwnKeyTurn["auth"];
  reasoningEffort?: ModelReasoningEffort;
  explicitTemperature?: number;
}) {
  if (HOSTED_MODE) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Local provider credentials cannot run on a hosted service.",
    );
  }
  const { model, input } = args;
  if (
    process.env.CONVEX_HTTP_URL &&
    input.apiKey &&
    model.provider !== "ollama" &&
    model.provider !== "custom"
  ) {
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Personal provider keys aren't supported. Configure cloud models in your organization's settings (Organization Models).",
      { code: "personal_byok_unsupported" },
    );
  }
  const turn: OwnKeyTurn = {
    projectId: args.projectId,
    selection: args.selection,
    provider: model.provider,
    hasRequestKey: Boolean(input.apiKey),
    auth: args.auth,
  };
  const policy = await ownKeyTurnCheck(turn);
  if (policy.refusal) throw policy.refusal;
  const effort = directChatEffort({
    providerKey: String(model.provider),
    modelId: String(model.id),
    effort: args.reasoningEffort,
    explicitTemperature: args.explicitTemperature,
  });
  if (!effort.ok)
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, effort.reason);
  return {
    model: withOwnKeyTurnPolicy(
      createLlmModel(
        model,
        input.apiKey ?? "",
        input.baseUrls,
        input.customProviders,
      ),
      turn,
      { allowedAt: policy.readAt },
    ),
    providerOptions: effort.providerOptions,
  };
}
