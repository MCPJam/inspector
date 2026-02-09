import { getModelById } from "../../shared/types";

/**
 * Mapping from AI SDK model IDs to ai-tokenizer model IDs.
 * Keys: Model IDs used by the application (AI SDK format)
 * Values: Model IDs recognized by ai-tokenizer
 */
const MODEL_ID_MAPPINGS: Record<string, string> = {
  // Anthropic models
  "claude-opus-4-1": "anthropic/claude-opus-4.1",
  "claude-opus-4-0": "anthropic/claude-opus-4",
  "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "claude-sonnet-4-0": "anthropic/claude-sonnet-4",
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-3-7-sonnet-latest": "anthropic/claude-3.7-sonnet",
  "claude-3-5-sonnet-latest": "anthropic/claude-3.5-sonnet",
  "claude-3-5-haiku-latest": "anthropic/claude-3.5-haiku",
  "anthropic/claude-opus-4-0": "anthropic/claude-opus-4",
  "anthropic/claude-sonnet-4-0": "anthropic/claude-sonnet-4",
  "anthropic/claude-3-7-sonnet-latest": "anthropic/claude-3.7-sonnet",
  "anthropic/claude-3-5-sonnet-latest": "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3-5-haiku-latest": "anthropic/claude-3.5-haiku",
  // Anthropic - constructed IDs (provider/model with dashes → provider/model with dots)
  "anthropic/claude-opus-4-1": "anthropic/claude-opus-4.1",
  "anthropic/claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",

  // OpenAI models
  "gpt-4": "openai/gpt-4-turbo",
  "gpt-4-turbo": "openai/gpt-4-turbo",
  "gpt-4.1": "openai/gpt-4.1",
  "gpt-4.1-mini": "openai/gpt-4.1-mini",
  "gpt-4.1-nano": "openai/gpt-4.1-mini", // nano maps to mini (closest)
  "gpt-4o": "openai/gpt-4o",
  "gpt-4o-mini": "openai/gpt-4o-mini",
  "gpt-5": "openai/gpt-5",
  "gpt-5-mini": "openai/gpt-5-mini",
  "gpt-5-nano": "openai/gpt-5-nano",
  "gpt-5-pro": "openai/gpt-5-pro",
  "gpt-5-codex": "openai/gpt-5-codex",
  "gpt-5.1": "openai/gpt-5.1-instant", // Map to closest available
  "gpt-5.1-codex": "openai/gpt-5.1-codex",
  "gpt-5.1-codex-mini": "openai/gpt-5.1-codex-mini",

  // DeepSeek models
  "deepseek-chat": "deepseek/deepseek-v3.1",
  "deepseek-reasoner": "deepseek/deepseek-r1",
  "deepseek/deepseek-v3.2": "deepseek/deepseek-v3.2-exp",

  // Google Gemini models
  "gemini-3-pro-preview": "google/gemini-3-pro-preview",
  "gemini-2.5-pro": "google/gemini-2.5-pro",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite",
  "gemini-2.0-flash-exp": "google/gemini-2.0-flash",

  // Meta models
  "meta-llama/llama-4-scout": "meta/llama-4-scout",

  // Mistral models
  "mistral-large-latest": "mistral/mistral-large",
  "mistral-small-latest": "mistral/mistral-small",
  "codestral-latest": "mistral/codestral",
  "ministral-8b-latest": "mistral/mistral-small",
  "ministral-3b-latest": "mistral/mistral-small",

  // xAI models (normalize x-ai to xai)
  "grok-3": "xai/grok-3",
  "grok-3-mini": "xai/grok-3-mini",
  "grok-code-fast-1": "xai/grok-code-fast-1",
  "grok-4-fast-non-reasoning": "xai/grok-4-fast-non-reasoning",
  "grok-4-fast-reasoning": "xai/grok-4-fast-reasoning",
  "x-ai/grok-4.1-fast": "xai/grok-4.1-fast",
  "x-ai/grok-code-fast-1": "xai/grok-code-fast-1",

  // Moonshot models
  "moonshotai/kimi-k2-thinking": "moonshotai/kimi-k2-thinking",
  "moonshotai/kimi-k2-0905": "moonshotai/kimi-k2-0905",
  "moonshotai/kimi-k2.5": "moonshotai/kimi-k2.5",

  // Google Gemini models (constructed IDs)
  "google/gemini-3-flash-preview": "google/gemini-3-flash-preview",

  // ZAI models (normalize z-ai to zai)
  "z-ai/glm-4.7": "zai/glm-4.7",
  "z-ai/glm-4.7-flash": "zai/glm-4.7-flash",

  // MiniMax models
  "minimax/minimax-m2.1": "minimax/minimax-m2.1",
};

/**
 * Maps application model IDs to tokenizer backend model IDs.
 * Maps to model IDs recognized by the ai-tokenizer backend.
 * Returns null if no mapping exists (should use character-based fallback).
 */
export function mapModelIdToTokenizerBackend(modelId: string): string | null {
  // 1. Check direct mapping first
  if (MODEL_ID_MAPPINGS[modelId]) {
    return MODEL_ID_MAPPINGS[modelId];
  }

  // 2. Handle models with provider prefix that just need normalization
  if (modelId.includes("/")) {
    // Normalize provider prefixes
    let normalized = modelId;
    if (modelId.startsWith("x-ai/")) {
      normalized = modelId.replace("x-ai/", "xai/");
    } else if (modelId.startsWith("z-ai/")) {
      normalized = modelId.replace("z-ai/", "zai/");
    }

    // Check if normalized version is in mappings
    if (MODEL_ID_MAPPINGS[normalized]) {
      return MODEL_ID_MAPPINGS[normalized];
    }

    // Return normalized version as-is (already has provider prefix)
    return normalized;
  }

  // 3. For models without prefix, construct provider/model format
  const modelDef = getModelById(modelId);
  if (modelDef) {
    const constructed = `${modelDef.provider}/${modelId}`;
    // Check if constructed version has a mapping
    if (MODEL_ID_MAPPINGS[constructed]) {
      return MODEL_ID_MAPPINGS[constructed];
    }
    return constructed;
  }

  // 4. No mapping found - return null to trigger fallback
  return null;
}

/**
 * Character-based token estimation fallback: 1 token ≈ 4 characters
 */
export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}
