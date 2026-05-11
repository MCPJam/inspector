import type { UIMessage } from "@ai-sdk/react";
import type { ExecutionConfig } from "./chat-execution-config";

export type EvalChatHandoff = {
  id: string;
  messages: UIMessage[];
  serverNames: string[];
  executionConfig: ExecutionConfig;
};
