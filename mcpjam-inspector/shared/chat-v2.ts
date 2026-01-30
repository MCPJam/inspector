import { UIMessage } from "ai";
import type { ModelDefinition } from "./types";

export interface ChatV2Request {
  messages: UIMessage[];
  model?: ModelDefinition;
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  apiKey?: string;
  ollamaBaseUrl?: string;
  litellmBaseUrl?: string;
  azureBaseUrl?: string;
  anthropicBaseUrl?: string;
  openaiBaseUrl?: string;
  selectedServers?: string[];
  /** If true, require user approval before executing each tool call */
  requireToolApproval?: boolean;
}
