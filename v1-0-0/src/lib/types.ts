import { LogHandler } from "@mastra/mcp";
import { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { OAuthClientState } from "./oauth-types";

// Shared model definitions
export type ModelProvider = "anthropic" | "openai";

export interface ModelDefinition {
  id: string;
  name: string;
  provider: ModelProvider;
}

export const SUPPORTED_MODELS: ModelDefinition[] = [
  {
    id: "claude-4-opus-20250514",
    name: "Claude 4 Opus",
    provider: "anthropic",
  },
  {
    id: "claude-4-sonnet-20250514",
    name: "Claude 4 Sonnet",
    provider: "anthropic",
  },
  {
    id: "claude-3-7-sonnet-20250219",
    name: "Claude 3.7 Sonnet",
    provider: "anthropic",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet (Oct 2024)",
    provider: "anthropic",
  },
  {
    id: "claude-3-5-sonnet-20240620",
    name: "Claude 3.5 Sonnet (Jun 2024)",
    provider: "anthropic",
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    provider: "anthropic",
  },
  {
    id: "claude-3-opus-20240229",
    name: "Claude 3 Opus",
    provider: "anthropic",
  },
  {
    id: "claude-3-sonnet-20240229",
    name: "Claude 3 Sonnet",
    provider: "anthropic",
  },
  {
    id: "claude-3-haiku-20240307",
    name: "Claude 3 Haiku",
    provider: "anthropic",
  },
  { id: "o3-mini", name: "O3 Mini", provider: "openai" },
  { id: "o3", name: "O3", provider: "openai" },
  { id: "o4-mini", name: "O4 Mini", provider: "openai" },
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano", provider: "openai" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  {
    id: "gpt-4o-audio-preview",
    name: "GPT-4o Audio Preview",
    provider: "openai",
  },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai" },
  { id: "gpt-4", name: "GPT-4", provider: "openai" },
  { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", provider: "openai" },
  { id: "o1", name: "O1", provider: "openai" },
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
