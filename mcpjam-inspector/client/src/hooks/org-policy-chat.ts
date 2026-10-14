import type { ChatTransport, UIMessage } from "ai";
import type { ModelDefinition } from "@/shared/types";
import {
  isOrgKeysDisallowedRow,
  orgKeysDisallowedNotice,
} from "@/components/chat-v2/shared/available-models";
import {
  ORG_KEYS_MODEL_REASON,
  ORG_POLICY_LOADING_REASON,
} from "@/lib/org-keys-refusal";

export function orgPolicySendRefusal(
  model: ModelDefinition,
  pending: boolean,
): string {
  if (pending) return ORG_POLICY_LOADING_REASON;
  return isOrgKeysDisallowedRow(model)
    ? orgKeysDisallowedNotice(model)
    : ORG_KEYS_MODEL_REASON;
}

export function orgPolicyBlocksChatSend(args: {
  pending: boolean;
  requireOrgKeys: boolean;
  selectedModel: ModelDefinition;
  availableModels: readonly ModelDefinition[];
}): boolean {
  const { selectedModel: model } = args;
  if (args.pending || isOrgKeysDisallowedRow(model)) return true;
  if (!args.requireOrgKeys) return false;
  return (
    model.disabled === true ||
    !model.orgProvider?.id ||
    !args.availableModels.some(
      (row) =>
        row.disabled !== true &&
        row.id === model.id &&
        row.orgProvider?.id === model.orgProvider?.id,
    )
  );
}

/** The final boundary for sends, including retries and automatic tool turns. */
export function orgPolicyChatTransport(
  getTransport: () => ChatTransport<UIMessage>,
  getPolicy: () => {
    blocked: boolean;
    pending: boolean;
    model: ModelDefinition;
  },
): ChatTransport<UIMessage> {
  return {
    async sendMessages(options) {
      const policy = getPolicy();
      if (policy.blocked)
        throw new Error(orgPolicySendRefusal(policy.model, policy.pending));
      return getTransport().sendMessages(options);
    },
    reconnectToStream: (options) => getTransport().reconnectToStream(options),
  };
}
