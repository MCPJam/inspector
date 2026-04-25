import type { UIMessage } from "@ai-sdk/react";

export type EvalChatHandoff = {
  id: string;
  messages: UIMessage[];
  serverNames: string[];
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
};
