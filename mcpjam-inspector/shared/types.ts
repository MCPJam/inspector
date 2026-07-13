// Shared types between client and server
import { HOSTED_MODEL_IDS } from "./hosted-model-ids.generated";

import type { XaaRegistrationStrategy } from "./xaa";

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
  | "bedrock"
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

// The MCPJam-hosted ("free") model ids — the billing seed. Sourced from the
// checked-in generated snapshot (emitted by the backend model-catalog
// generator), no longer hand-maintained. The server-side hosted-model catalog
// PRE-SEEDS its dynamic cache from this list, so the union of (seed ∪ backend
// catalog) keeps billing classification correct even when the catalog is
// empty/unreachable (a cold start still bills hosted models to MCPJam credits).
export const MCPJAM_PROVIDED_MODEL_IDS: string[] = [...HOSTED_MODEL_IDS];

const MCPJAM_GUEST_GATED_MODEL_IDS = [
  "mistralai/mistral-medium-3-5",
  "mistralai/mistral-large-2512",
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
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-fable-5",
  "google/gemini-3.1-pro-preview",
] as const;

const gatedGuestModelIds = new Set<string>(MCPJAM_GUEST_GATED_MODEL_IDS);

const MCPJAM_GUEST_ALLOWED_MODEL_IDS: string[] =
  MCPJAM_PROVIDED_MODEL_IDS.filter(
    (modelId) => !gatedGuestModelIds.has(modelId)
  );

/** Minimal shape `getCanonicalModelId` matches against — `SUPPORTED_MODELS`
 * satisfies it, and so does a `ModelDefinition[]` derived from the backend
 * catalog. */
export type CanonicalModelCandidate = { id: string | Model; provider: string };

// Canonical (OpenRouter-style) id prefixes whose ModelProvider key differs from
// the prefix. Everything else uses the prefix verbatim.
const HOSTED_PROVIDER_ALIASES: Record<string, string> = {
  "x-ai": "xai",
  "meta-llama": "meta",
  mistralai: "mistral",
};

/** Derive the provider key from a canonical hosted id's prefix. */
export function hostedProviderFromCanonicalId(id: string): string {
  const slash = id.indexOf("/");
  const prefix = (slash > 0 ? id.slice(0, slash) : id).toLowerCase();
  return HOSTED_PROVIDER_ALIASES[prefix] ?? prefix;
}

// The hosted snapshot projected to `{ id, provider }` so `getCanonicalModelId`
// can still map a BARE hosted id (e.g. "gpt-5-nano" + provider "openai") to its
// prefixed form now that the hosted display rows are gone from SUPPORTED_MODELS.
const HOSTED_CANONICAL_CANDIDATES: CanonicalModelCandidate[] =
  HOSTED_MODEL_IDS.map((id) => ({
    id,
    provider: hostedProviderFromCanonicalId(id),
  }));

export const getCanonicalModelId = (
  modelId: string,
  provider?: string,
  /**
   * Extra known models to canonicalize against (unioned with the static
   * `SUPPORTED_MODELS`). The client injects the dynamic backend catalog ∪ BYOK
   * list here so catalog-only ids canonicalize correctly; defaults to `[]`, so
   * every server/shared caller keeps the exact prior static behavior.
   */
  extraModels: readonly CanonicalModelCandidate[] = []
): string => {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return normalizedModelId;
  }

  // BYOK statics (SUPPORTED_MODELS) + the hosted snapshot candidates (hosted
  // display rows were removed from SUPPORTED_MODELS) + any injected catalog.
  const knownModels: readonly CanonicalModelCandidate[] =
    extraModels.length > 0
      ? [...SUPPORTED_MODELS, ...HOSTED_CANONICAL_CANDIDATES, ...extraModels]
      : [...SUPPORTED_MODELS, ...HOSTED_CANONICAL_CANDIDATES];

  const normalizedProvider = provider?.trim().toLowerCase();

  // When a provider is supplied, prefer hosted/prefixed matches first so
  // bare ids (e.g. "gpt-4o-mini" — BYOK) don't shadow their hosted
  // counterparts (e.g. "openai/gpt-4o-mini" — MCPJam-provided).
  if (normalizedProvider) {
    const providerModels = knownModels.filter(
      (model) => model.provider.toLowerCase() === normalizedProvider
    );

    // If the caller didn't already pass a prefixed id, look for a prefixed
    // (hosted) match first within this provider — bare ids must not win here.
    const prefixedMatch = !normalizedModelId.includes("/")
      ? providerModels.find((model) =>
          String(model.id).endsWith(`/${normalizedModelId}`)
        )
      : undefined;

    const providerScopedMatch =
      prefixedMatch ??
      providerModels.find((model) => String(model.id) === normalizedModelId);

    if (providerScopedMatch) {
      return String(providerScopedMatch.id);
    }
  }

  const exactMatch = knownModels.find(
    (model) => String(model.id) === normalizedModelId
  );
  if (exactMatch) {
    return String(exactMatch.id);
  }

  return normalizedModelId;
};

export const isMCPJamProvidedModel = (
  modelId: string,
  provider?: string
): boolean => {
  return MCPJAM_PROVIDED_MODEL_IDS.includes(
    getCanonicalModelId(modelId, provider)
  );
};

export const isMCPJamGuestAllowedModel = (
  modelId: string,
  provider?: string
): boolean => {
  return MCPJAM_GUEST_ALLOWED_MODEL_IDS.includes(
    getCanonicalModelId(modelId, provider)
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
  /**
   * Known provider keys keep autocomplete; `string` is accepted so a brand-new
   * backend-catalog provider (e.g. "alibaba", "nvidia") renders on its own with
   * no code change — the whole point of sourcing the picker from the catalog.
   */
  provider: ModelProvider | (string & {});
  /** Set when provider === "custom" to identify which custom provider to use */
  customProviderName?: string;
  contextLength?: number;
  disabled?: boolean;
  disabledReason?: string;
  /**
   * True when the model comes from the MCPJam backend hosted catalog (billed to
   * MCPJam credits). Drives `isMCPJamProvidedModelMenuItem` and the free/paid
   * locks. Absent on BYOK/org/custom models.
   */
  hosted?: boolean;
  /**
   * Whether MCPJam serves this hosted model to signed-out guests. Sourced from
   * the catalog DTO; absent → treated as guest-gated (locked for guests).
   */
  guestAllowed?: boolean;
}

export enum Model {
  CLAUDE_FABLE_5 = "claude-fable-5",
  CLAUDE_SONNET_5 = "claude-sonnet-5",
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
  MISTRAL_SMALL_2603 = "mistral-small-2603",
  MISTRAL_MEDIUM_3_5 = "mistral-medium-3-5",
  MISTRAL_LARGE_2512 = "mistral-large-2512",
  DEVSTRAL_2512 = "devstral-2512",
  CODESTRAL_LATEST = "codestral-latest",
  MINISTRAL_8B_LATEST = "ministral-8b-latest",
  MINISTRAL_3B_LATEST = "ministral-3b-latest",
  // xAI models
  GROK_3 = "grok-3",
  GROK_3_MINI = "grok-3-mini",
  GROK_CODE_FAST_1 = "grok-code-fast-1",
  GROK_4_5 = "grok-4.5",
  GROK_4_FAST_NON_REASONING = "grok-4-fast-non-reasoning",
  GROK_4_FAST_REASONING = "grok-4-fast-reasoning",
}

// SUPPORTED_MODELS now holds only BYOK entries (the user brings their own key):
// `Model.*`-enum ids and "azure/…" ids. Hosted ("free") models are no longer
// listed here — they come from the backend catalog (live) or the generated
// snapshot (fallback). See hostedModelDefinitionsFromSnapshot / HOSTED_MODEL_IDS.
export const SUPPORTED_MODELS: ModelDefinition[] = [
  {
    id: Model.CLAUDE_FABLE_5,
    name: "Claude Fable 5",
    provider: "anthropic",
    contextLength: 1000000,
  },
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
  // Mistral models
  {
    id: Model.MISTRAL_SMALL_2603,
    name: "Mistral Small 4",
    provider: "mistral",
    contextLength: 262144,
  },
  {
    id: Model.MISTRAL_MEDIUM_3_5,
    name: "Mistral Medium 3.5",
    provider: "mistral",
    contextLength: 262144,
  },
  {
    id: Model.MISTRAL_LARGE_2512,
    name: "Mistral Large 3 2512",
    provider: "mistral",
    contextLength: 262144,
  },
  {
    id: Model.DEVSTRAL_2512,
    name: "Devstral 2 2512",
    provider: "mistral",
    contextLength: 262144,
  },
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
    id: Model.GROK_4_5,
    name: "Grok 4.5",
    provider: "xai",
    contextLength: 500000,
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

const HOSTED_MODEL_IDS_SET: ReadonlySet<string> = new Set(HOSTED_MODEL_IDS);

export const isModelSupported = (id: string): boolean => {
  const canonical = getCanonicalModelId(id);
  // BYOK statics (bare `Model.*`/azure ids) — the exhaustive local list.
  if (SUPPORTED_MODELS.some((model) => model.id === id)) return true;
  // Known hosted model from the snapshot seed.
  if (HOSTED_MODEL_IDS_SET.has(canonical)) return true;
  // A provider-prefixed id we don't statically know may still be a valid
  // backend-catalog model added AFTER this snapshot (or an org OpenRouter /
  // custom selection). Treat it as supported and let the live catalog / runtime
  // be the real gate — gating on the static snapshot here would re-introduce
  // the hand-maintained ceiling the dynamic catalog exists to remove.
  return canonical.includes("/");
};

/**
 * Derive a readable display name from a canonical hosted id for the fallback
 * path (guests/offline see this instead of the live catalog's curated name):
 * drop the redundant provider prefix (the picker groups by provider) and
 * title-case the model segment. e.g. "openai/gpt-4o-mini" → "Gpt 4o Mini".
 */
export function hostedDisplayNameFromCanonicalId(id: string): string {
  const slash = id.indexOf("/");
  const modelPart = slash >= 0 ? id.slice(slash + 1) : id;
  const titled = modelPart
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return titled || id;
}

/**
 * Build ModelDefinitions for the full hosted ("free") catalog from the snapshot
 * seed — the client picker's last-resort fallback when the live backend catalog
 * is unreachable (guest / offline / Electron / empty cache). Display names are
 * derived from the id (rich metadata comes from the live catalog); provider is
 * derived from the id prefix. Never empty.
 */
export function hostedModelDefinitionsFromSnapshot(): ModelDefinition[] {
  return HOSTED_MODEL_IDS.map((id) => ({
    id,
    name: hostedDisplayNameFromCanonicalId(id),
    provider: hostedProviderFromCanonicalId(id),
    hosted: true,
    guestAllowed: isMCPJamGuestAllowedModel(id),
  }));
}

/**
 * Amazon Bedrock model ids are bare strings like
 * "us.anthropic.claude-sonnet-4-5-20250929-v1:0" — an optional geo prefix
 * (us./eu./apac./us-gov./global/...), a known vendor segment, a model name,
 * and an optional ":N" revision suffix (absent on legacy ids like
 * "anthropic.claude-v2" or "amazon.titan-tg1-large"). Ollama ids (the other
 * bare-id shape in the app) never carry a `vendor.` segment from this list,
 * so the pattern safely disambiguates the two (e.g. "llama3.1:8b" or
 * "mistral:latest" don't match).
 */
const BEDROCK_BARE_MODEL_ID_PATTERN =
  /^(?:[a-z]{2,6}(?:-[a-z]+)?\.)?(?:ai21|amazon|anthropic|cohere|deepseek|luma|meta|minimax|mistral|moonshot|nvidia|openai|qwen|stability|twelvelabs|writer)\.[A-Za-z0-9][\w.-]*(?::\d+)?$/;

/**
 * True when a model id is recognizably Amazon Bedrock: a bare model /
 * inference-profile id, or a Bedrock ARN (e.g.
 * "arn:aws:bedrock:us-east-1:123456789012:inference-profile/..."). The ARN
 * check is partition-agnostic so GovCloud/China ARNs (arn:aws-us-gov:...,
 * arn:aws-cn:...) match too.
 */
export const isBedrockModelId = (modelId: string): boolean => {
  return (
    /^arn:aws(?:-[a-z0-9-]+)?:bedrock:/i.test(modelId) ||
    BEDROCK_BARE_MODEL_ID_PATTERN.test(modelId)
  );
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

/**
 * The auth type a server-form row is configured with. "xaa" (Cross-App Access)
 * is a distinct flow from "oauth": the inspector server mints the access token
 * server-side via token-exchange rather than running a browser OAuth flow.
 */
export type ServerFormAuthType = "oauth" | "bearer" | "none" | "xaa";

export interface ServerFormData {
  name: string;
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  secretPatch?: {
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  clientCapabilities?: Record<string, unknown>;
  useOAuth?: boolean;
  oauthProtocolMode?: ServerFormOAuthProtocolMode;
  oauthRegistrationMode?: ServerFormOAuthRegistrationMode;
  oauthScopes?: string[];
  clientId?: string;
  clientSecret?: string;
  hasClientSecret?: boolean;
  clearClientSecret?: boolean;
  /** Optional issuer override for the cross-app authorization test target. */
  xaaAuthzIssuer?: string;
  /**
   * Opt-in: accept a path-scoped authorization server whose metadata
   * advertises the same-origin root as issuer (multi-tenant AS deployments
   * with path-scoped issuers). Off = strict RFC 8414 issuer match.
   */
  xaaAllowPathScopedIssuer?: boolean;
  /**
   * Cross-App Access (XAA) connect flag. When true the server authenticates via
   * the XAA token-exchange flow rather than standard OAuth. Mutually exclusive
   * with `useOAuth` — the form only ever sets one.
   */
  useXaa?: boolean;
  /**
   * Which identity provider mints the XAA assertion. v1 only writes "mcpjam"
   * (the built-in test IdP); "own" is reserved for the bring-your-own-IdP
   * follow-up.
   */
  authServerMode?: "mcpjam" | "own";
  /** Optional simulated-identity override (subject) for the MCPJam test IdP. Blank = signed-in user. */
  xaaSubject?: string;
  /** Optional simulated-identity override (email) for the MCPJam test IdP. Blank = signed-in user. */
  xaaEmail?: string;
  /**
   * XAA Debugger registration strategy (Client↔Resource-AS leg): how the run
   * establishes its client identity at the target authorization server. Chosen
   * in the "Configure Server to Test" modal. Debugger-only — the Connect page
   * never sets it, so merges must preserve an existing value.
   */
  xaaRegistrationStrategy?: XaaRegistrationStrategy;
  /** Registry credential key for resolving OAuth client ID from env (e.g. "github") */
  oauthCredentialKey?: string;
  /** True for registry servers that use backend-managed preregistered OAuth credentials */
  useRegistryOAuthProxy?: boolean;
  requestTimeout?: number;
  /** Convex _id of the registry server for project/registry bookkeeping */
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
