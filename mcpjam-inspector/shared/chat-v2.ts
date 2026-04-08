import { UIMessage } from "ai";
import type { ModelDefinition } from "./types";

export interface ChatV2Request {
  messages: UIMessage[];
  chatSessionId?: string;
  surface?: "preview" | "share_link";
  serverUrl?: string;
  serverHeaders?: Record<string, string>;
  oauthAccessToken?: string;
  clientCapabilities?: Record<string, unknown>;
  model?: ModelDefinition;
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  apiKey?: string;
  ollamaBaseUrl?: string;
  azureBaseUrl?: string;
  customProviders?: Array<{
    name: string;
    protocol: string;
    baseUrl: string;
    modelIds: string[];
    apiKey?: string;
  }>;
  selectedServers?: string[];
  requireToolApproval?: boolean;
  /** When present, the server resolves model provider config from the org backing this workspace. */
  workspaceId?: string;
}
