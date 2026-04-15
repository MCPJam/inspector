import type { UIMessage } from "@ai-sdk/react";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";

export type EvalChatHandoff = {
  id: string;
  messages: UIMessage[];
  serverNames: string[];
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  requestPayloadHistory?: LiveChatTraceRequestPayloadEntry[];
};
