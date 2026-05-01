// Shared types between client and server

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
  | "azure"
  | "openai"
  | "ollama"
  | "deepseek"
  | "google"
  | "meta"
  | "xai"
  | "mistral"
  | "moonshotai"
  | "openrouter"
  | "z-ai"
  | "minimax"
  | "qwen"
  | "custom";

const MCPJAM_PROVIDED_MODEL_IDS: string[] = [
  "openai/gpt-oss-120b",
  "openai/gpt-4o-mini",
  "openai/gpt-5-nano",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.6-fast",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5-mini",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-chat",
  "moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2-0905",
  "google/gemini-2.5-flash",
  "z-ai/glm-4.6",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemma-4-31b-it",
  "x-ai/grok-code-fast-1",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "google/gemini-3-flash-preview",
  "meta-llama/llama-4-scout",
  "moonshotai/kimi-k2.5",
  "x-ai/grok-4.1-fast",
  "x-ai/grok-4-fast",
  "x-ai/grok-4.20",
  "z-ai/glm-4.7",
  "z-ai/glm-4.7-flash",
  "z-ai/glm-5.1",
  "minimax/minimax-m2.1",
  "minimax/minimax-m2.7",
  "qwen/qwen3.6-plus",
  "qwen/qwen3.5-9b",
  "qwen/qwen3.5-35b-a3b",
  "qwen/qwen3.5-27b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3.5-flash-02-23",
  "qwen/qwen3-max-thinking",
];

const MCPJAM_GUEST_GATED_MODEL_IDS = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "anthropic/claude-opus-4.6-fast",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "google/gemini-3.1-pro-preview",
] as const;

const gatedGuestModelIds = new Set<string>(MCPJAM_GUEST_GATED_MODEL_IDS);

const MCPJAM_GUEST_ALLOWED_MODEL_IDS: string[] =
  MCPJAM_PROVIDED_MODEL_IDS.filter(
    (modelId) => !gatedGuestModelIds.has(modelId),
  );

export const getCanonicalModelId = (
  modelId: string,
  provider?: string,
): string => {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return normalizedModelId;
  }

  const normalizedProvider = provider?.trim().toLowerCase();

  // When a provider is supplied, prefer hosted/prefixed matches first so
  // bare ids (e.g. "gpt-4o-mini" — BYOK) don't shadow their hosted
  // counterparts (e.g. "openai/gpt-4o-mini" — MCPJam-provided).
  if (normalizedProvider) {
    const providerModels = SUPPORTED_MODELS.filter(
      (model) => model.provider.toLowerCase() === normalizedProvider,
    );

    // If the caller didn't already pass a prefixed id, look for a prefixed
    // (hosted) match first within this provider — bare ids must not win here.
    const prefixedMatch = !normalizedModelId.includes("/")
      ? providerModels.find((model) =>
          String(model.id).endsWith(`/${normalizedModelId}`),
        )
      : undefined;

    const providerScopedMatch =
      prefixedMatch ??
      providerModels.find((model) => String(model.id) === normalizedModelId);

    if (providerScopedMatch) {
      return String(providerScopedMatch.id);
    }
  }

  const exactMatch = SUPPORTED_MODELS.find(
    (model) => String(model.id) === normalizedModelId,
  );
  if (exactMatch) {
    return String(exactMatch.id);
  }

  return normalizedModelId;
};

export const isMCPJamProvidedModel = (
  modelId: string,
  provider?: string,
): boolean => {
  return MCPJAM_PROVIDED_MODEL_IDS.includes(
    getCanonicalModelId(modelId, provider),
  );
};

export const isMCPJamGuestAllowedModel = (
  modelId: string,
  provider?: string,
): boolean => {
  return MCPJAM_GUEST_ALLOWED_MODEL_IDS.includes(
    getCanonicalModelId(modelId, provider),
  );
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
  /** Set when provider === "custom" to identify which custom provider to use */
  customProviderName?: string;
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

const freeModel = (
  id: string,
  name: string,
  provider: ModelProvider,
  contextLength?: number,
): ModelDefinition => ({
  id,
  name: `${name} (Free)`,
  provider,
  ...(contextLength !== undefined ? { contextLength } : {}),
});

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
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B (Free)",
    provider: "openai",
    contextLength: 131072,
  },
  freeModel("openai/gpt-4o-mini", "GPT-4o Mini", "openai", 128000),
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano (Free)",
    provider: "openai",
    contextLength: 16000,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5 (Free)",
    provider: "anthropic",
    contextLength: 200000,
  },
  freeModel("anthropic/claude-opus-4.5", "Claude Opus 4.5", "anthropic"),
  freeModel("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "anthropic"),
  freeModel(
    "anthropic/claude-opus-4.6-fast",
    "Claude Opus 4.6 Fast",
    "anthropic",
  ),
  freeModel("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6", "anthropic"),
  freeModel("anthropic/claude-opus-4.6", "Claude Opus 4.6", "anthropic"),
  freeModel("anthropic/claude-opus-4.7", "Claude Opus 4.7", "anthropic"),
  {
    id: "openai/gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini (Free)",
    provider: "openai",
    contextLength: 400000,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini (Free)",
    provider: "openai",
    contextLength: 128000,
  },
  freeModel("openai/gpt-5.4", "GPT-5.4", "openai"),
  freeModel("openai/gpt-5.4-mini", "GPT-5.4 Mini", "openai"),
  freeModel("openai/gpt-5.4-pro", "GPT-5.4 Pro", "openai"),
  freeModel("openai/gpt-5.4-nano", "GPT-5.4 Nano", "openai"),
  freeModel("openai/gpt-5.5", "GPT-5.5", "openai"),
  freeModel("openai/gpt-5.5-pro", "GPT-5.5 Pro", "openai"),
  freeModel("openai/gpt-5.3-codex", "GPT-5.3 Codex", "openai"),
  freeModel("openai/gpt-5.3-chat", "GPT-5.3 Chat", "openai"),
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
  freeModel("z-ai/glm-4.6", "GLM 4.6", "z-ai", 200000),
  freeModel(
    "google/gemini-3.1-flash-lite-preview",
    "Gemini 3.1 Flash Lite Preview",
    "google",
  ),
  freeModel(
    "google/gemini-3.1-pro-preview",
    "Gemini 3.1 Pro Preview",
    "google",
  ),
  freeModel("google/gemma-4-31b-it", "Gemma 4 31B Instruct", "google"),
  {
    id: "x-ai/grok-code-fast-1",
    name: "Grok Code Fast 1 (Free)",
    provider: "xai",
    contextLength: 256000,
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2 (Free)",
    provider: "deepseek",
    contextLength: 128000,
  },
  freeModel("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek"),
  freeModel("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", "deepseek"),
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview (Free)",
    provider: "google",
    contextLength: 1048576,
  },
  {
    id: "meta-llama/llama-4-scout",
    name: "Llama 4 Scout (Free)",
    provider: "meta",
    contextLength: 512000,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5 (Free)",
    provider: "moonshotai",
    contextLength: 262144,
  },
  {
    id: "x-ai/grok-4.1-fast",
    name: "Grok 4.1 Fast (Free)",
    provider: "xai",
    contextLength: 2000000,
  },
  freeModel("x-ai/grok-4-fast", "Grok 4 Fast", "xai"),
  freeModel("x-ai/grok-4.20", "Grok 4.20", "xai"),
  {
    id: "z-ai/glm-4.7",
    name: "GLM 4.7 (Free)",
    provider: "z-ai",
    contextLength: 200000,
  },
  {
    id: "z-ai/glm-4.7-flash",
    name: "GLM 4.7 Flash (Free)",
    provider: "z-ai",
    contextLength: 200000,
  },
  {
    id: "z-ai/glm-5.1",
    name: "GLM 5.1 (Free)",
    provider: "z-ai",
    contextLength: 200000,
  },
  {
    id: "minimax/minimax-m2.1",
    name: "MiniMax M2.1 (Free)",
    provider: "minimax",
    contextLength: 128000,
  },
  freeModel("minimax/minimax-m2.7", "MiniMax M2.7", "minimax"),
  freeModel("qwen/qwen3.6-plus", "Qwen 3.6 Plus", "qwen"),
  freeModel("qwen/qwen3.5-9b", "Qwen 3.5 9B", "qwen"),
  freeModel("qwen/qwen3.5-35b-a3b", "Qwen 3.5 35B A3B", "qwen"),
  freeModel("qwen/qwen3.5-27b", "Qwen 3.5 27B", "qwen"),
  freeModel("qwen/qwen3.5-122b-a10b", "Qwen 3.5 122B A10B", "qwen"),
  freeModel("qwen/qwen3.5-flash-02-23", "Qwen 3.5 Flash 02-23", "qwen"),
  freeModel("qwen/qwen3-max-thinking", "Qwen 3 Max Thinking", "qwen"),
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
    contextLength: 256000,
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

  // Azure Models
  {
    id: "azure/gpt-5.1",
    name: "GPT-5.1 (Azure)",
    provider: "azure",
    contextLength: 400000,
  },
  {
    id: "azure/gpt-5.1-codex",
    name: "GPT-5.1 Codex (Azure)",
    provider: "azure",
    contextLength: 400000,
  },
  {
    id: "azure/gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini (Azure)",
    provider: "azure",
    contextLength: 400000,
  },
];

// Helper functions for models
export const getModelById = (id: string): ModelDefinition | undefined => {
  return SUPPORTED_MODELS.find((model) => model.id === id);
};

export const isModelSupported = (id: string): boolean => {
  return SUPPORTED_MODELS.some((model) => model.id === id);
};

export type ServerFormOAuthProtocolMode =
  | "auto"
  | "2025-03-26"
  | "2025-06-18"
  | "2025-11-25";

export type ServerFormOAuthRegistrationMode =
  | "auto"
  | "cimd"
  | "dcr"
  | "preregistered";

export interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  clientCapabilities?: Record<string, unknown>;
  useOAuth?: boolean;
  oauthProtocolMode?: ServerFormOAuthProtocolMode;
  oauthRegistrationMode?: ServerFormOAuthRegistrationMode;
  oauthScopes?: string[];
  clientId?: string;
  clientSecret?: string;
  /** Registry credential key for resolving OAuth client ID from env (e.g. "github") */
  oauthCredentialKey?: string;
  /** True for registry servers that use backend-managed preregistered OAuth credentials */
  useRegistryOAuthProxy?: boolean;
  requestTimeout?: number;
  /** Convex _id of the registry server for workspace/registry bookkeeping */
  registryServerId?: string;
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
