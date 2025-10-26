import { UIMessage } from "ai";
import type { ModelDefinition } from "./types";

export interface ChatV2Request {
  messages: UIMessage[];
  model?: ModelDefinition;
  modelId?: string;
  temperature?: number;
  apiKey?: string;
  ollamaBaseUrl?: string;
  litellmBaseUrl?: string;
}
