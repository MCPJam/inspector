import { UIMessage } from "ai";
import type { ModelDefinition } from "./types";

export interface ChatV2Request {
  messages: UIMessage[];
  chatSessionId?: string;
  directVisibility?: "private" | "workspace";
  surface?: "preview" | "share_link";
  serverName?: string;
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
  selectedServerNames?: string[];
  requireToolApproval?: boolean;
  /** Workspace ID for direct-chat history persistence */
  workspaceId?: string;
  /** Version for optimistic concurrency on resumed threads */
  expectedVersion?: number;
}
