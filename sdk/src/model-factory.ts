/**
 * Model factory for creating AI SDK language models from provider/model strings.
 * Supports both built-in providers and user-defined custom providers.
 *
 * Also exports buildOrgModelFromResolvedConfig / assertOrgModelAllowed for
 * building models from org-resolved provider configs (local BYOK runtime).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import type { LanguageModel } from "ai";
import type { LLMProvider, CustomProvider } from "./types.js";

/**
 * Custom base URLs for built-in providers that support them.
 */
export interface BaseUrls {
  ollama?: string;
  azure?: string;
  anthropic?: string;
  openai?: string;
}

/**
 * Options for creating a model.
 */
export interface CreateModelOptions {
  apiKey: string;
  baseUrls?: BaseUrls;
  /** Custom providers registry (name -> config) */
  customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
}

/** Built-in providers list */
const BUILT_IN_PROVIDERS: LLMProvider[] = [
  "anthropic",
  "openai",
  "azure",
  "deepseek",
  "google",
  "ollama",
  "mistral",
  "openrouter",
  "xai",
];

/**
 * Result of parsing an LLM string
 */
export type ParsedLLMString =
  | { type: "builtin"; provider: LLMProvider; model: string }
  | { type: "custom"; providerName: string; model: string };

/**
 * Parse an LLM string into provider and model components.
 * Supports both built-in providers and custom provider names.
 *
 * @param llmString - String in format "provider/model" (e.g., "openai/gpt-4o" or "my-litellm/gpt-4")
 * @param customProviderNames - Optional set of registered custom provider names for validation
 * @returns Parsed result with type discriminator
 */
export function parseLLMString(
  llmString: string,
  customProviderNames?: Set<string>
): ParsedLLMString {
  const parts = llmString.split("/");
  if (parts.length < 2) {
    throw new Error(
      `Invalid LLM string format: "${llmString}". Expected format: "provider/model" (e.g., "openai/gpt-4o")`
    );
  }

  const providerName = parts[0];
  const model = parts.slice(1).join("/"); // Handle models with slashes in name

  // Check if it's a built-in provider
  if (BUILT_IN_PROVIDERS.includes(providerName as LLMProvider)) {
    return {
      type: "builtin",
      provider: providerName as LLMProvider,
      model,
    };
  }

  // Check if it's a registered custom provider
  if (customProviderNames?.has(providerName)) {
    return {
      type: "custom",
      providerName,
      model,
    };
  }

  // Unknown provider
  const allProviders = customProviderNames
    ? [...BUILT_IN_PROVIDERS, ...customProviderNames]
    : BUILT_IN_PROVIDERS;

  throw new Error(
    `Unknown LLM provider: "${providerName}". Supported providers: ${allProviders.join(", ")}`
  );
}

/**
 * Model type returned by provider factories.
 */
export type ProviderLanguageModel = ReturnType<ReturnType<typeof createOpenAI>>;

/**
 * Create a model from a custom provider configuration.
 */
function createModelFromCustomProvider(
  customProvider: CustomProvider,
  model: string,
  runtimeApiKey?: string
): ProviderLanguageModel {
  // Resolve API key: runtime > config > env var
  const apiKey =
    runtimeApiKey ||
    customProvider.apiKey ||
    (customProvider.apiKeyEnvVar
      ? process.env[customProvider.apiKeyEnvVar]
      : undefined) ||
    "";

  switch (customProvider.protocol) {
    case "openai-compatible": {
      const openai = createOpenAI({
        apiKey,
        baseURL: customProvider.baseUrl,
      });
      // Use .chat() for providers that need Chat Completions API (like LiteLLM)
      return customProvider.useChatCompletions
        ? openai.chat(model)
        : openai(model);
    }

    case "anthropic-compatible": {
      const anthropic = createAnthropic({
        apiKey,
        baseURL: customProvider.baseUrl,
      });
      return anthropic(model) as ProviderLanguageModel;
    }

    default: {
      const _exhaustiveCheck: never = customProvider.protocol;
      throw new Error(`Unknown protocol: ${_exhaustiveCheck}`);
    }
  }
}

/**
 * Create a language model from an LLM string.
 * @param llmString - String in format "provider/model" (e.g., "openai/gpt-4o" or "my-provider/model")
 * @param options - API key, optional base URLs, and custom providers registry
 * @returns AI SDK language model instance
 */
export function createModelFromString(
  llmString: string,
  options: CreateModelOptions
): ProviderLanguageModel {
  const { apiKey, baseUrls, customProviders } = options;

  // Convert custom providers to Map if provided as object
  const customProvidersMap =
    customProviders instanceof Map
      ? customProviders
      : customProviders
        ? new Map(Object.entries(customProviders))
        : new Map<string, CustomProvider>();

  const customProviderNames = new Set(customProvidersMap.keys());
  const parsed = parseLLMString(llmString, customProviderNames);

  // Handle custom providers
  if (parsed.type === "custom") {
    const customProvider = customProvidersMap.get(parsed.providerName);
    if (!customProvider) {
      throw new Error(
        `Custom provider "${parsed.providerName}" not found in registry`
      );
    }
    return createModelFromCustomProvider(customProvider, parsed.model, apiKey);
  }

  // Handle built-in providers
  const { provider, model } = parsed;

  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey,
        ...(baseUrls?.anthropic && { baseURL: baseUrls.anthropic }),
      });
      return anthropic(model) as ProviderLanguageModel;
    }

    case "openai": {
      const openai = createOpenAI({
        apiKey,
        ...(baseUrls?.openai && { baseURL: baseUrls.openai }),
      });
      return openai(model);
    }

    case "deepseek": {
      const deepseek = createDeepSeek({ apiKey });
      return deepseek(model) as ProviderLanguageModel;
    }

    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model) as ProviderLanguageModel;
    }

    case "ollama": {
      // Normalize the base URL to ensure it ends with /api
      const raw = baseUrls?.ollama || "http://127.0.0.1:11434/api";
      const normalized = /\/api\/?$/.test(raw)
        ? raw
        : `${raw.replace(/\/+$/, "")}/api`;
      const ollama = createOllama({ baseURL: normalized });
      return ollama(model) as unknown as ProviderLanguageModel;
    }

    case "mistral": {
      const mistral = createMistral({ apiKey });
      return mistral(model) as ProviderLanguageModel;
    }

    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey });
      return openrouter(model) as unknown as ProviderLanguageModel;
    }

    case "xai": {
      const xai = createXai({ apiKey });
      return xai(model) as ProviderLanguageModel;
    }

    case "azure": {
      const azure = createAzure({
        apiKey,
        baseURL: baseUrls?.azure,
      });
      return azure(model) as ProviderLanguageModel;
    }

    default: {
      const _exhaustiveCheck: never = provider;
      throw new Error(`Unhandled provider: ${_exhaustiveCheck}`);
    }
  }
}

/**
 * Parse a comma-separated string of model IDs into an array.
 * Handles whitespace and empty entries.
 */
export function parseModelIds(modelIdsString: string): string[] {
  return modelIdsString
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Create a CustomProvider configuration from user input.
 * This is a helper for building the configuration from form inputs.
 */
export function createCustomProvider(config: {
  name: string;
  protocol: "openai-compatible" | "anthropic-compatible";
  baseUrl: string;
  modelIds: string | string[];
  apiKey?: string;
  apiKeyEnvVar?: string;
  useChatCompletions?: boolean;
}): CustomProvider {
  const modelIds = Array.isArray(config.modelIds)
    ? config.modelIds
    : parseModelIds(config.modelIds);

  if (modelIds.length === 0) {
    throw new Error("At least one model ID is required");
  }

  if (!config.name || config.name.includes("/")) {
    throw new Error("Provider name is required and cannot contain '/'");
  }

  if (!config.baseUrl) {
    throw new Error("Base URL is required");
  }

  return {
    name: config.name,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    modelIds,
    ...(config.apiKey && { apiKey: config.apiKey }),
    ...(config.apiKeyEnvVar && { apiKeyEnvVar: config.apiKeyEnvVar }),
    ...(config.useChatCompletions && {
      useChatCompletions: config.useChatCompletions,
    }),
  };
}

/**
 * Preset configurations for common OpenAI-compatible providers.
 * Users can use these as starting points and customize as needed.
 */
export const PROVIDER_PRESETS = {
  /** LiteLLM proxy - requires useChatCompletions */
  litellm: (
    baseUrl = "http://localhost:4000",
    modelIds: string[]
  ): CustomProvider => ({
    name: "litellm",
    protocol: "openai-compatible",
    baseUrl,
    modelIds,
    apiKeyEnvVar: "LITELLM_API_KEY",
    useChatCompletions: true,
  }),
} as const;

// =============================================================================
// Org-resolved provider config builder
//
// Used by the inspector's local BYOK runtime: after calling /stream/org/resolve
// and receiving a local-runtime response, the inspector builds the AI SDK model
// here rather than forwarding the request to Convex.
// =============================================================================

/**
 * Resolved provider config as returned by /stream/org/resolve for local providers.
 * Cloud providers do not send apiKey — only local providers include credentials.
 */
export interface OrgProviderResolvedConfig {
  providerKey: string;
  /** Present only for local-runtime providers. */
  apiKey?: string;
  baseUrl?: string;
  protocol?: "openai-compatible" | "anthropic-compatible";
  modelIds?: string[];
  displayName?: string;
  selectedModels?: string[];
}

export class OrgProviderConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OrgProviderConfigError";
  }
}

function requireOrgSecret(
  config: OrgProviderResolvedConfig,
  label: string
): string {
  if (!config.apiKey) {
    throw new OrgProviderConfigError(
      "provider_not_configured",
      `${label} provider has no API key configured for this organization`
    );
  }
  return config.apiKey;
}

function requireOrgBaseUrl(
  config: OrgProviderResolvedConfig,
  label: string
): string {
  if (!config.baseUrl) {
    throw new OrgProviderConfigError(
      "provider_not_configured",
      `${label} provider has no base URL configured for this organization`
    );
  }
  return config.baseUrl;
}

function resolveOrgModelId(
  config: OrgProviderResolvedConfig,
  modelId: string
): string {
  if (!config.providerKey.startsWith("custom:")) return modelId;
  const prefix = `${config.providerKey}:`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/**
 * Build an AI SDK LanguageModel from an org-resolved provider config.
 *
 * Mirrors convex/stream/buildOrgModel.ts — kept in sync so local and cloud
 * execution use the same provider dispatch logic.
 *
 * Throws OrgProviderConfigError('provider_not_configured', ...) when a
 * required apiKey or baseUrl is missing.
 */
export function buildOrgModelFromResolvedConfig(
  config: OrgProviderResolvedConfig,
  modelId: string
): LanguageModel {
  const { providerKey } = config;
  // Strip the "providerKey/" prefix that UI model IDs include for built-in
  // providers (e.g. "openai/gpt-5-mini" → "gpt-5-mini" for the OpenAI SDK).
  const builtinPfx = `${providerKey}/`;
  const m =
    !providerKey.startsWith("custom:") && modelId.startsWith(builtinPfx)
      ? modelId.slice(builtinPfx.length)
      : modelId;

  if (providerKey === "openai") {
    return createOpenAI({ apiKey: requireOrgSecret(config, "OpenAI") })(m);
  }
  if (providerKey === "anthropic") {
    return createAnthropic({
      apiKey: requireOrgSecret(config, "Anthropic"),
    })(m) as unknown as LanguageModel;
  }
  if (providerKey === "google") {
    return createGoogleGenerativeAI({
      apiKey: requireOrgSecret(config, "Google"),
    })(m) as unknown as LanguageModel;
  }
  if (providerKey === "deepseek") {
    return createDeepSeek({
      apiKey: requireOrgSecret(config, "DeepSeek"),
    })(m) as unknown as LanguageModel;
  }
  if (providerKey === "mistral") {
    return createMistral({
      apiKey: requireOrgSecret(config, "Mistral"),
    })(m) as unknown as LanguageModel;
  }
  if (providerKey === "xai") {
    return createXai({ apiKey: requireOrgSecret(config, "xAI") })(
      m
    ) as unknown as LanguageModel;
  }
  if (providerKey === "azure") {
    const apiKey = requireOrgSecret(config, "Azure OpenAI");
    const baseUrl = requireOrgBaseUrl(config, "Azure OpenAI");
    const resourceMatch = baseUrl.match(
      /https?:\/\/([^.]+)\.(openai|cognitiveservices)\.azure\.com/i
    );
    const resourceName = resourceMatch?.[1];
    return createAzure({
      apiKey,
      ...(resourceName ? { resourceName } : { baseURL: baseUrl }),
    })(m) as unknown as LanguageModel;
  }
  if (providerKey === "openrouter") {
    return createOpenRouter({
      apiKey: requireOrgSecret(config, "OpenRouter"),
      headers: {
        "HTTP-Referer": "https://www.mcpjam.com/",
        "X-Title": "MCPJam",
      },
    })(m) as unknown as LanguageModel;
  }
  if (providerKey === "ollama") {
    const raw = requireOrgBaseUrl(config, "Ollama");
    const normalized = /\/api\/?$/.test(raw)
      ? raw
      : `${raw.replace(/\/+$/, "")}/api`;
    return createOllama({
      baseURL: normalized,
    })(m) as unknown as LanguageModel;
  }
  if (providerKey.startsWith("custom:")) {
    const baseUrl = requireOrgBaseUrl(config, providerKey);
    const apiKey = config.apiKey ?? "";
    const resolvedModelId = resolveOrgModelId(config, modelId);
    if (config.protocol === "anthropic-compatible") {
      return createAnthropic({
        apiKey,
        baseURL: baseUrl,
      })(resolvedModelId) as unknown as LanguageModel;
    }
    const openai = createOpenAI({ apiKey, baseURL: baseUrl });
    return openai.chat(resolvedModelId);
  }

  throw new OrgProviderConfigError(
    "provider_not_supported",
    `Provider ${providerKey} is not supported`
  );
}

/**
 * Validate that the requested model is in the org's allowlist for the provider.
 * For OpenRouter this is selectedModels; for custom providers it is modelIds.
 * Built-in providers are pass-through (the upstream provider rejects unknown ids).
 *
 * Throws OrgProviderConfigError('model_not_allowed', ...) on rejection.
 */
export function assertOrgModelAllowed(
  config: OrgProviderResolvedConfig,
  modelId: string
): void {
  if (config.providerKey === "openrouter") {
    if (config.selectedModels && config.selectedModels.length > 0) {
      if (!config.selectedModels.includes(modelId)) {
        throw new OrgProviderConfigError(
          "model_not_allowed",
          `Model ${modelId} is not in this organization's OpenRouter allowlist`
        );
      }
    }
    return;
  }
  if (config.providerKey.startsWith("custom:")) {
    const resolvedModelId = resolveOrgModelId(config, modelId);
    if (config.modelIds && config.modelIds.length > 0) {
      if (!config.modelIds.includes(resolvedModelId)) {
        throw new OrgProviderConfigError(
          "model_not_allowed",
          `Model ${resolvedModelId} is not configured for custom provider ${config.providerKey}`
        );
      }
    }
  }
}
