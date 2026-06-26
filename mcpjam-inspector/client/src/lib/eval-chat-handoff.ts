import type { UIMessage } from "@ai-sdk/react";
import type { ExecutionConfig } from "./chat-execution-config";

export type EvalChatHandoff = {
  id: string;
  messages: UIMessage[];
  serverNames: string[];
  executionConfig: ExecutionConfig;
  /**
   * A user message to send (live) once the seeded conversation is applied —
   * set when a widget in the eval preview fired a `ui/message` follow-up, so
   * the playground continues the conversation and the model replies, exactly
   * as it would in live chat.
   */
  pendingUserMessage?: string;
};

/**
 * Build a CONFIG-ONLY handoff for the live eval Chat panel (Record mode).
 *
 * Unlike "Continue in chat" (which seeds a prior run's `messages`), the live
 * Record panel starts an empty thread bound to the case's model / system /
 * temperature / tool-approval, then prefills or auto-runs the case's first
 * prompt so a live widget mounts. We deliberately do NOT seed prior assistant
 * /tool turns — replaying earlier widgets live needs sequential replay, which
 * is out of scope here (seeding `user` text alone wouldn't re-render them).
 *
 * The `id` is derived from the case id so the same case yields a stable handoff
 * identity (`PlaygroundMain` consumes a handoff once per id).
 */
export function buildCaseChatHandoff(params: {
  caseId: string;
  serverNames: string[];
  modelId?: string;
  advancedConfig?: {
    system?: unknown;
    temperature?: unknown;
    requireToolApproval?: unknown;
  } | null;
}): EvalChatHandoff {
  const { caseId, serverNames, modelId, advancedConfig } = params;
  return {
    id: `eval-live:${caseId}`,
    messages: [],
    serverNames,
    executionConfig: {
      modelId,
      systemPrompt:
        typeof advancedConfig?.system === "string"
          ? advancedConfig.system
          : undefined,
      temperature:
        typeof advancedConfig?.temperature === "number"
          ? advancedConfig.temperature
          : undefined,
      requireToolApproval:
        typeof advancedConfig?.requireToolApproval === "boolean"
          ? advancedConfig.requireToolApproval
          : undefined,
    },
  };
}
