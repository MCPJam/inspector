// Shared types between client and server

import { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

// Legacy server config (keeping for compatibility)
export interface ServerConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// Chat and messaging types
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  attachments?: Attachment[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metadata?: MessageMetadata;
}

export interface ToolCall {
  id: string | number;
  name: string;
  parameters: Record<string, any>;
  timestamp: Date;
  status: "pending" | "executing" | "completed" | "error";
  result?: any;
  error?: string;
}

export interface Attachment {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size?: number;
}

export interface ToolResult {
  id: string;
  toolCallId: string;
  result: any;
  error?: string;
  timestamp: Date;
}

export interface MessageMetadata {
  createdAt: string;
  editedAt?: string;
  regenerated?: boolean;
  tokens?: {
    input: number;
    output: number;
  };
}

export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string;
  connectionStatus: "connected" | "disconnected" | "connecting";
}

export interface ChatActions {
  sendMessage: (content: string, attachments?: Attachment[]) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  deleteMessage: (messageId: string) => void;
  clearChat: () => void;
  stopGeneration: () => void;
}

export interface MCPToolCall extends ToolCall {
  serverId: string;
  serverName: string;
}

export interface MCPToolResult extends ToolResult {
  serverId: string;
}

export type ChatStatus = "idle" | "typing" | "streaming" | "error";

export interface StreamingMessage {
  id: string;
  content: string;
  isComplete: boolean;
}

// Model definitions
export type ModelProvider =
  | "anthropic"
  | "openai"
  | "ollama"
  | "deepseek"
  | "google"
  | "meta"
  | "xai"
  | "litellm"
  | "mistral"
  | "moonshotai"
  | "openrouter"
  | "z-ai";

const MCPJAM_PROVIDED_MODEL_IDS: string[] = [
  "meta-llama/llama-3.3-70b-instruct",
  "openai/gpt-oss-120b",
  "x-ai/grok-4-fast",
  "openai/gpt-5-nano",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.1",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5-codex",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "google/gemini-2.5-flash-preview-09-2025",
  "moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2-0905",
  "google/gemini-2.5-flash",
  "z-ai/glm-4.6",
];

export const isMCPJamProvidedModel = (modelId: string): boolean => {
  return MCPJAM_PROVIDED_MODEL_IDS.includes(modelId);
};

export const isGPT5Model = (modelId: string | Model): boolean => {
  const id = String(modelId);
  // Only disable temperature for OpenAI GPT-5 models (not MCPJam provided ones)
  // MCPJam provided models like "openai/gpt-5" still support temperature
  if (isMCPJamProvidedModel(id)) {
    return false;
  }
  return id.includes("gpt-5");
};

export interface ModelDefinition {
  id: Model | string;
  name: string;
  provider: ModelProvider;
  contextLength?: number;
  disabled?: boolean;
  disabledReason?: string;
}

export enum Model {
  CLAUDE_OPUS_4_1 = "claude-opus-4-1",
  CLAUDE_OPUS_4_0 = "claude-opus-4-0",
  CLAUDE_SONNET_4_5 = "claude-sonnet-4-5",
  CLAUDE_SONNET_4_0 = "claude-sonnet-4-0",
  CLAUDE_3_7_SONNET_LATEST = "claude-3-7-sonnet-latest",
  CLAUDE_HAIKU_4_5 = "claude-haiku-4-5",
  CLAUDE_3_5_HAIKU_LATEST = "claude-3-5-haiku-latest",
  GPT_4_1 = "gpt-4.1",
  GPT_4_1_MINI = "gpt-4.1-mini",
  GPT_4_1_NANO = "gpt-4.1-nano",
  GPT_4O = "gpt-4o",
  GPT_4O_MINI = "gpt-4o-mini",
  GPT_4_TURBO = "gpt-4-turbo",
  GPT_4 = "gpt-4",
  GPT_5 = "gpt-5",
  GPT_5_MINI = "gpt-5-mini",
  GPT_5_NANO = "gpt-5-nano",
  GPT_5_MAIN = "openai/gpt-5",
  GPT_5_PRO = "gpt-5-pro",
  GPT_5_CODEX = "gpt-5-codex",
  GPT_5_1 = "gpt-5.1",
  GPT_5_1_CODEX = "gpt-5.1-codex",
  GPT_5_1_CODEX_MINI = "gpt-5.1-codex-mini",
  GPT_3_5_TURBO = "gpt-3.5-turbo",
  DEEPSEEK_CHAT = "deepseek-chat",
  DEEPSEEK_REASONER = "deepseek-reasoner",
  // Google Gemini models
  GEMINI_3_PRO = "gemini-3-pro-preview",
  GEMINI_2_5_PRO = "gemini-2.5-pro",
  GEMINI_2_5_FLASH = "gemini-2.5-flash",
  GEMINI_2_5_FLASH_LITE = "gemini-2.5-flash-lite",
  GEMINI_2_0_FLASH_EXP = "gemini-2.0-flash-exp",
  // Google Gemma models
  GEMMA_3_2B = "gemma-3-2b",
  GEMMA_3_9B = "gemma-3-9b",
  GEMMA_3_27B = "gemma-3-27b",
  GEMMA_2_2B = "gemma-2-2b",
  GEMMA_2_9B = "gemma-2-9b",
  GEMMA_2_27B = "gemma-2-27b",
  CODE_GEMMA_2B = "codegemma-2b",
  CODE_GEMMA_7B = "codegemma-7b",
  // Mistral models
  MISTRAL_LARGE_LATEST = "mistral-large-latest",
  MISTRAL_SMALL_LATEST = "mistral-small-latest",
  CODESTRAL_LATEST = "codestral-latest",
  MINISTRAL_8B_LATEST = "ministral-8b-latest",
  MINISTRAL_3B_LATEST = "ministral-3b-latest",
  // xAI models
  GROK_3 = "grok-3",
  GROK_3_MINI = "grok-3-mini",
  GROK_CODE_FAST_1 = "grok-code-fast-1",
  GROK_4_FAST_NON_REASONING = "grok-4-fast-non-reasoning",
  GROK_4_FAST_REASONING = "grok-4-fast-reasoning",
}

export const SUPPORTED_MODELS: ModelDefinition[] = [
  {
    id: Model.CLAUDE_OPUS_4_1,
    name: "Claude Opus 4.1",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.CLAUDE_OPUS_4_0,
    name: "Claude Opus 4",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.CLAUDE_SONNET_4_5,
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.CLAUDE_SONNET_4_0,
    name: "Claude Sonnet 4",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.CLAUDE_HAIKU_4_5,
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.CLAUDE_3_7_SONNET_LATEST,
    name: "Claude Sonnet 3.7",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.CLAUDE_3_5_HAIKU_LATEST,
    name: "Claude Haiku 3.5",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: Model.GPT_5_1,
    name: "GPT-5.1",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: Model.GPT_5_1_CODEX,
    name: "GPT-5.1 Codex",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: Model.GPT_5_1_CODEX_MINI,
    name: "GPT-5.1 Codex Mini",
    provider: "openai",
    contextLength: 200000,
  },
  {
    id: "openai/gpt-5.1",
    name: "GPT-5.1 (Free)",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: "openai/gpt-5.1-codex",
    name: "GPT-5.1 Codex (Free)",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: "openai/gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini (Free)",
    provider: "openai",
    contextLength: 200000,
  },
  { id: Model.GPT_5, name: "GPT-5", provider: "openai", contextLength: 400000 },
  {
    id: Model.GPT_5_MINI,
    name: "GPT-5 Mini",
    provider: "openai",
    contextLength: 200000,
  },
  {
    id: Model.GPT_5_NANO,
    name: "GPT-5 Nano",
    provider: "openai",
    contextLength: 128000,
  },
  {
    id: Model.GPT_5_PRO,
    name: "GPT-5 Pro",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: Model.GPT_5_CODEX,
    name: "GPT-5 Codex",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: Model.GPT_4_1,
    name: "GPT-4.1",
    provider: "openai",
    contextLength: 1047576,
  },
  {
    id: Model.GPT_4_1_MINI,
    name: "GPT-4.1 Mini",
    provider: "openai",
    contextLength: 1047576,
  },
  {
    id: Model.GPT_4_1_NANO,
    name: "GPT-4.1 Nano",
    provider: "openai",
    contextLength: 1047576,
  },
  {
    id: Model.GPT_4O,
    name: "GPT-4o",
    provider: "openai",
    contextLength: 128000,
  },
  {
    id: Model.GPT_4O_MINI,
    name: "GPT-4o Mini",
    provider: "openai",
    contextLength: 128000,
  },
  {
    id: Model.DEEPSEEK_CHAT,
    name: "DeepSeek Chat",
    provider: "deepseek",
    contextLength: 128000,
  },
  {
    id: Model.DEEPSEEK_REASONER,
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    contextLength: 128000,
  },
  // Google Gemini models (latest first)
  {
    id: Model.GEMINI_3_PRO,
    name: "Gemini 3 Pro (Preview)",
    provider: "google",
    contextLength: 1000000,
  },
  {
    id: Model.GEMINI_2_5_PRO,
    name: "Gemini 2.5 Pro",
    provider: "google",
    contextLength: 2000000,
  },
  {
    id: Model.GEMINI_2_5_FLASH,
    name: "Gemini 2.5 Flash",
    provider: "google",
    contextLength: 1000000,
  },
  {
    id: Model.GEMINI_2_0_FLASH_EXP,
    name: "Gemini 2.0 Flash Experimental",
    provider: "google",
    contextLength: 1048576,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B (Free)",
    provider: "meta",
    contextLength: 128000,
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B (Free)",
    provider: "openai",
    contextLength: 131072,
  },
  {
    id: "x-ai/grok-4-fast",
    name: "Grok 4 Fast (Free)",
    provider: "xai",
    contextLength: 2000000,
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano (Free)",
    provider: "openai",
    contextLength: 16000,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Free)",
    provider: "anthropic",
    contextLength: 1000000,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5 (Free)",
    provider: "anthropic",
    contextLength: 200000,
  },
  {
    id: "openai/gpt-5-codex",
    name: "GPT-5 Codex (Free)",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: "openai/gpt-5",
    name: "GPT-5 (Free)",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini (Free)",
    provider: "openai",
    contextLength: 128000,
  },
  {
    id: "google/gemini-2.5-flash-preview-09-2025",
    name: "Gemini 2.5 Flash Preview (Free)",
    provider: "google",
    contextLength: 1048576,
  },
  {
    id: "moonshotai/kimi-k2-thinking",
    name: "Kimi K2 Thinking (Free)",
    provider: "moonshotai",
    contextLength: 262144,
  },
  {
    id: "moonshotai/kimi-k2-0905",
    name: "Kimi K2 (Free)",
    provider: "moonshotai",
    contextLength: 262144,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash (Free)",
    provider: "google",
    contextLength: 1048576,
  },
  {
    id: "z-ai/glm-4.6",
    name: "GLM 4.6 (Free)",
    provider: "z-ai",
    contextLength: 200000,
  },
  // Mistral models
  {
    id: Model.MISTRAL_LARGE_LATEST,
    name: "Mistral Large",
    provider: "mistral",
    contextLength: 131072,
  },
  {
    id: Model.MISTRAL_SMALL_LATEST,
    name: "Mistral Small",
    provider: "mistral",
    contextLength: 128000,
  },
  {
    id: Model.CODESTRAL_LATEST,
    name: "Codestral",
    provider: "mistral",
    contextLength: 256000,
  },
  {
    id: Model.MINISTRAL_8B_LATEST,
    name: "Ministral 8B",
    provider: "mistral",
    contextLength: 128000,
  },
  {
    id: Model.MINISTRAL_3B_LATEST,
    name: "Ministral 3B",
    provider: "mistral",
    contextLength: 128000,
  },
  // xAI models
  {
    id: Model.GROK_3,
    name: "Grok 3",
    provider: "xai",
    contextLength: 131072,
  },
  {
    id: Model.GROK_3_MINI,
    name: "Grok 3 Mini",
    provider: "xai",
    contextLength: 131072,
  },
  {
    id: Model.GROK_CODE_FAST_1,
    name: "Grok Code Fast 1",
    provider: "xai",
    contextLength: 128000,
  },
  {
    id: Model.GROK_4_FAST_NON_REASONING,
    name: "Grok 4 Fast Non-Reasoning",
    provider: "xai",
    contextLength: 2000000,
  },
  {
    id: Model.GROK_4_FAST_REASONING,
    name: "Grok 4 Fast Reasoning",
    provider: "xai",
    contextLength: 2000000,
  },
];

// Helper functions for models
export const getModelById = (id: string): ModelDefinition | undefined => {
  return SUPPORTED_MODELS.find((model) => model.id === id);
};

export const isModelSupported = (id: string): boolean => {
  return SUPPORTED_MODELS.some((model) => model.id === id);
};

// MCP Server Definition Types
export type BaseServerOptions = {
  name?: string;
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
  // Note: authProvider is intentionally not included because it can't be serialized
  // when sending configs over HTTP. OAuth tokens should be in requestInit headers.
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  oauth?: any;
  oauthScopes?: string[]; // Persist OAuth scopes in config
  clientId?: string; // Persist OAuth client ID in config
  clientSecret?: string; // Persist OAuth client secret in config
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
  clientId?: string;
  clientSecret?: string;
  requestTimeout?: number;
}

export interface OauthTokens {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export interface AuthSettings {
  serverUrl: string;
  tokens: OAuthTokens | null;
  isAuthenticating: boolean;
  error: string | null;
  statusMessage: StatusMessage | null;
}

export interface StatusMessage {
  type: "success" | "error" | "info";
  message: string;
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  serverUrl: "",
  tokens: null,
  isAuthenticating: false,
  error: null,
  statusMessage: null,
};

// MCP Resource and Tool types
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<MCPPromptArgument>;
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ConnectionTestResponse {
  success: boolean;
  error?: string;
  details?: string;
}

export interface ChatStreamEvent {
  type:
    | "text"
    | "tool_call"
    | "tool_result"
    | "elicitation_request"
    | "elicitation_complete"
    | "error";
  content?: string;
  toolCall?: ToolCall;
  toolResult?: {
    id: string | number;
    toolCallId: string | number;
    result?: any;
    error?: string;
    timestamp: Date;
  };
  requestId?: string;
  message?: string;
  schema?: any;
  error?: string;
  timestamp?: Date;
}

// Server status types
export interface ServerStatus {
  status: "ok" | "error";
  timestamp: string;
  service?: string;
}
