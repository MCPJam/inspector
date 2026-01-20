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
  deepseekBaseUrl?: string;
  googleBaseUrl?: string;
  mistralBaseUrl?: string;
  xaiBaseUrl?: string;
  selectedServers?: string[];
}
