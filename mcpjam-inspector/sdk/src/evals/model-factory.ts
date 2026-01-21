/**
 * Model factory for creating AI SDK model instances.
 *
 * Adapted from server/utils/chat-helpers.ts to be SDK-independent.
 * Supports multiple LLM providers: Anthropic, OpenAI, DeepSeek, Google,
 * Ollama, Mistral, LiteLLM, OpenRouter, xAI, and Azure.
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

/**
 * Supported LLM providers.
 */
export type ModelProvider =
  | "anthropic"
  | "azure"
  | "openai"
  | "ollama"
  | "deepseek"
  | "google"
  | "mistral"
  | "litellm"
  | "openrouter"
  | "xai";

/**
 * Model definition for creating an LLM instance.
 */
export interface ModelDefinition {
  /** Model ID (e.g., "gpt-4o", "claude-3-opus-20240229") */
  id: string;
  /** Provider identifier */
  provider: ModelProvider;
}

/**
 * Optional base URLs for providers that support custom endpoints.
 */
export interface BaseUrls {
  /** Custom Ollama API base URL */
  ollama?: string;
  /** Custom LiteLLM API base URL */
  litellm?: string;
  /** Custom Azure OpenAI base URL */
  azure?: string;
  /** Custom Anthropic base URL */
  anthropic?: string;
  /** Custom OpenAI base URL */
  openai?: string;
}

/**
 * Parses a model string in the format "provider/model-id" or just "model-id".
 *
 * Handles model IDs that contain slashes (e.g., OpenRouter's "meta/llama-3").
 * For "openrouter/meta/llama-3", returns { provider: "openrouter", id: "meta/llama-3" }.
 *
 * @param llm - Model string (e.g., "openai/gpt-4o", "openrouter/meta/llama-3", or "gpt-4o")
 * @returns Parsed model definition
 * @throws Error if the format is invalid (empty string)
 */
export function parseModelString(llm: string): ModelDefinition {
  const parts = llm.split("/");

  if (parts.length >= 2) {
    // Format: "provider/model-id" or "provider/org/model-id" (e.g., OpenRouter)
    // First part is the provider, rest is the model ID
    const [provider, ...rest] = parts;
    const id = rest.join("/");
    return {
      provider: provider as ModelProvider,
      id,
    };
  } else if (parts.length === 1 && parts[0]) {
    // Format: "model-id" - try to infer provider from model name
    const id = parts[0];
    const provider = inferProvider(id);
    return { provider, id };
  } else {
    throw new Error(
      `Invalid model format: ${llm}. Expected "provider/model-id" or "model-id"`,
    );
  }
}

/**
 * Infers the provider from a model ID based on common naming patterns.
 */
function inferProvider(modelId: string): ModelProvider {
  const lowerModelId = modelId.toLowerCase();

  if (lowerModelId.includes("claude")) {
    return "anthropic";
  }
  if (
    lowerModelId.includes("gpt") ||
    lowerModelId.startsWith("o1") ||
    lowerModelId.startsWith("o3")
  ) {
    return "openai";
  }
  if (lowerModelId.includes("gemini") || lowerModelId.includes("gemma")) {
    return "google";
  }
  if (lowerModelId.includes("deepseek")) {
    return "deepseek";
  }
  if (
    lowerModelId.includes("mistral") ||
    lowerModelId.includes("codestral") ||
    lowerModelId.includes("ministral")
  ) {
    return "mistral";
  }
  if (lowerModelId.includes("grok")) {
    return "xai";
  }
  if (lowerModelId.includes("llama") || lowerModelId.includes("qwen")) {
    return "ollama";
  }

  // Default to OpenAI for unknown models
  return "openai";
}

/**
 * Creates an AI SDK language model instance for the specified provider and model.
 *
 * @param modelDefinition - The model definition with provider and ID
 * @param apiKey - API key for the provider
 * @param baseUrls - Optional custom base URLs for providers
 * @returns AI SDK LanguageModel instance
 * @throws Error if the provider is unsupported or model definition is invalid
 *
 * @example
 * ```typescript
 * // Using ModelDefinition object
 * const model = createModel(
 *   { provider: "openai", id: "gpt-4o" },
 *   process.env.OPENAI_API_KEY
 * );
 *
 * // Using string format
 * const modelDef = parseModelString("anthropic/claude-3-opus-20240229");
 * const model = createModel(modelDef, process.env.ANTHROPIC_API_KEY);
 * ```
 */
export function createModel(
  modelDefinition: ModelDefinition,
  apiKey: string,
  baseUrls?: BaseUrls,
): LanguageModel {
  if (!modelDefinition?.id || !modelDefinition?.provider) {
    throw new Error(
      `Invalid model definition: ${JSON.stringify(modelDefinition)}`,
    );
  }

  switch (modelDefinition.provider) {
    case "anthropic":
      return createAnthropic({
        apiKey,
        ...(baseUrls?.anthropic && { baseURL: baseUrls.anthropic }),
      })(modelDefinition.id);

    case "openai":
      return createOpenAI({
        apiKey,
        ...(baseUrls?.openai && { baseURL: baseUrls.openai }),
      })(modelDefinition.id);

    case "deepseek":
      return createDeepSeek({ apiKey })(modelDefinition.id);

    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelDefinition.id);

    case "ollama": {
      const raw = baseUrls?.ollama || "http://127.0.0.1:11434/api";
      const normalized = /\/api\/?$/.test(raw)
        ? raw
        : `${raw.replace(/\/+$/, "")}/api`;
      return createOllama({ baseURL: normalized })(modelDefinition.id);
    }

    case "mistral":
      return createMistral({ apiKey })(modelDefinition.id);

    case "litellm": {
      // LiteLLM uses OpenAI-compatible endpoints (standard chat completions API)
      const baseURL = baseUrls?.litellm || "http://localhost:4000";
      // LiteLLM may not require API key depending on setup
      const litellmApiKey = apiKey || process.env.LITELLM_API_KEY || "";
      const openai = createOpenAI({
        apiKey: litellmApiKey,
        baseURL,
      });
      // Use .chat() to use Chat Completions API instead of Responses API
      return openai.chat(modelDefinition.id);
    }

    case "openrouter":
      return createOpenRouter({ apiKey })(modelDefinition.id);

    case "xai":
      return createXai({ apiKey })(modelDefinition.id);

    case "azure":
      return createAzure({ apiKey, baseURL: baseUrls?.azure })(
        modelDefinition.id,
      );

    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
}

/**
 * Convenience function to create a model from a string format.
 *
 * @param llm - Model string (e.g., "openai/gpt-4o" or "anthropic/claude-3-opus-20240229")
 * @param apiKey - API key for the provider
 * @param baseUrls - Optional custom base URLs
 * @returns AI SDK LanguageModel instance
 *
 * @example
 * ```typescript
 * const model = createModelFromString("openai/gpt-4o", process.env.OPENAI_API_KEY);
 * ```
 */
export function createModelFromString(
  llm: string,
  apiKey: string,
  baseUrls?: BaseUrls,
): LanguageModel {
  const modelDefinition = parseModelString(llm);
  return createModel(modelDefinition, apiKey, baseUrls);
}
