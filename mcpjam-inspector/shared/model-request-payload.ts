import type { ModelMessage } from "@ai-sdk/provider-utils";

export interface SerializedModelRequestTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ResolvedModelRequestPayload {
  system: string;
  tools: Record<string, SerializedModelRequestTool>;
  messages: ModelMessage[];
}
