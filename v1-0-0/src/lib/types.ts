import { LogHandler } from "@mastra/mcp";
import { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { OAuthClientState } from "./oauth-types";

// Shared model definitions
export type ModelProvider = "anthropic" | "openai" | "ollama";

export interface ModelDefinition {
  id: Model | string;
  name: string;
  provider: ModelProvider;
}

export enum Model {
  CLAUDE_4_OPUS_20250514 = "claude-4-opus-20250514",
  CLAUDE_4_SONNET_20250514 = "claude-4-sonnet-20250514",
  CLAUDE_3_7_SONNET_20250219 = "claude-3-7-sonnet-20250219",
  CLAUDE_3_5_SONNET_20241022 = "claude-3-5-sonnet-20241022",
  CLAUDE_3_5_SONNET_20240620 = "claude-3-5-sonnet-20240620",
  CLAUDE_3_5_HAIKU_20241022 = "claude-3-5-haiku-20241022",
  CLAUDE_3_OPUS_20240229 = "claude-3-opus-20240229",
  CLAUDE_3_SONNET_20240229 = "claude-3-sonnet-20240229",
  CLAUDE_3_HAIKU_20240307 = "claude-3-haiku-20240307",
  O3_MINI = "o3-mini",
  O3 = "o3",
  O4_MINI = "o4-mini",
  GPT_4_1 = "gpt-4.1",
  GPT_4_1_MINI = "gpt-4.1-mini",
  GPT_4_1_NANO = "gpt-4.1-nano",
  GPT_4O = "gpt-4o",
  GPT_4O_MINI = "gpt-4o-mini",
  GPT_4O_AUDIO_PREVIEW = "gpt-4o-audio-preview",
  GPT_4_TURBO = "gpt-4-turbo",
  GPT_4 = "gpt-4",
  GPT_3_5_TURBO = "gpt-3.5-turbo",
  O1 = "o1",
}

export const SUPPORTED_MODELS: ModelDefinition[] = [
  {
    id: Model.CLAUDE_4_OPUS_20250514,
    name: "Claude 4 Opus",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_4_SONNET_20250514,
    name: "Claude 4 Sonnet",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_7_SONNET_20250219,
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_5_SONNET_20241022,
    name: "Claude 3.5 Sonnet (Oct 2024)",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_5_SONNET_20240620,
    name: "Claude 3.5 Sonnet (Jun 2024)",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_5_HAIKU_20241022,
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_OPUS_20240229,
    name: "Claude 3 Opus",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_SONNET_20240229,
    name: "Claude 3 Sonnet",
    provider: "anthropic",
  },
  {
    id: Model.CLAUDE_3_HAIKU_20240307,
    name: "Claude 3 Haiku",
    provider: "anthropic",
  },
  { id: Model.O3_MINI, name: "O3 Mini", provider: "openai" },
  { id: Model.O3, name: "O3", provider: "openai" },
  { id: Model.O4_MINI, name: "O4 Mini", provider: "openai" },
  { id: Model.GPT_4_1, name: "GPT-4.1", provider: "openai" },
  { id: Model.GPT_4_1_MINI, name: "GPT-4.1 Mini", provider: "openai" },
  { id: Model.GPT_4_1_NANO, name: "GPT-4.1 Nano", provider: "openai" },
  { id: Model.GPT_4O, name: "GPT-4o", provider: "openai" },
  { id: Model.GPT_4O_MINI, name: "GPT-4o Mini", provider: "openai" },
  {
    id: Model.GPT_4O_AUDIO_PREVIEW,
    name: "GPT-4o Audio Preview",
    provider: "openai",
  },
  { id: Model.GPT_4_TURBO, name: "GPT-4 Turbo", provider: "openai" },
  { id: Model.GPT_4, name: "GPT-4", provider: "openai" },
  { id: Model.GPT_3_5_TURBO, name: "GPT-3.5 Turbo", provider: "openai" },
  { id: Model.O1, name: "O1", provider: "openai" },
];

// Helper function to get model by ID
export const getModelById = (id: string): ModelDefinition | undefined => {
  return SUPPORTED_MODELS.find((model) => model.id === id);
};

// Helper function to check if model is supported
export const isModelSupported = (id: string): boolean => {
  return SUPPORTED_MODELS.some((model) => model.id === id);
};

export type BaseServerOptions = {
  name?: string;
  logger?: LogHandler;
  timeout?: number;
  capabilities?: ClientCapabilities;
  enableServerLogs?: boolean;
};

export type StdioServerDefinition = BaseServerOptions & {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: never;
  requestInit?: never;
  eventSourceInit?: never;
  reconnectionOptions?: never;
  sessionId?: never;
  oauth?: never;
};

export type HttpServerDefinition = BaseServerOptions & {
  url: URL;
  command?: never;
  args?: never;
  env?: never;
  requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  oauth?: OAuthClientState;
};

export interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  useOAuth?: boolean;
  oauthScopes?: string[];
}

export type MastraMCPServerDefinition =
  | StdioServerDefinition
  | HttpServerDefinition;
