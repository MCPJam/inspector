import { getModelById } from "../../shared/types";

/**
 * Maps application model IDs to tokenizer backend model IDs.
 * Maps to model IDs recognized by the ai-tokenizer backend.
 * Returns null if no mapping exists (should use character-based fallback).
 */
export function mapModelIdToTokenizerBackend(modelId: string): string | null {
  switch (modelId) {
    // Anthropic special cases
    case "anthropic/claude-opus-4-0":
      return "anthropic/claude-opus-4";
    case "anthropic/claude-sonnet-4-0":
      return "anthropic/claude-sonnet-4";
    case "anthropic/claude-3-7-sonnet-latest":
      return "anthropic/claude-3.7-sonnet";
    case "anthropic/claude-3-5-sonnet-latest":
      return "anthropic/claude-3.5-sonnet";
    case "anthropic/claude-3-5-haiku-latest":
      return "anthropic/claude-3.5-haiku";

    // OpenAI special cases
    case "gpt-4":
      return "openai/gpt-4-turbo";

    // Google Gemini special cases
    case "gemini-2.0-flash-exp":
      return "google/gemini-2.0-flash";

    // Meta special cases
    case "meta-llama/llama-3.3-70b-instruct":
      return "meta/llama-3.3-70b";

    // DeepSeek special cases
    case "deepseek-chat":
      return "deepseek/deepseek-v3.1";
    case "deepseek-reasoner":
      return "deepseek/deepseek-r1";

    // Mistral special cases
    case "mistral-large-latest":
      return "mistral/mistral-large";
    case "mistral-small-latest":
      return "mistral/mistral-small";
    case "codestral-latest":
      return "mistral/codestral";
    case "ministral-8b-latest":
    case "ministral-3b-latest":
      return "mistral/mistral-small";

    // xAI special cases
    case "x-ai/grok-4-fast":
      return "xai/grok-4-fast-reasoning";
    case "x-ai/grok-code-fast-1":
      return "xai/grok-code-fast-1";

    // DeepSeek special cases for MCPJam provided models
    case "deepseek/deepseek-v3.2":
      return "deepseek/deepseek-v3.2";

    default:
      // Handle models that already have provider prefix
      if (modelId.includes("/")) {
        // Normalize provider prefixes (x-ai → xai, z-ai → zai)
        if (modelId.startsWith("x-ai/")) {
          return modelId.replace("x-ai/", "xai/");
        }
        if (modelId.startsWith("z-ai/")) {
          return modelId.replace("z-ai/", "zai/");
        }
        // Already prefixed and doesn't need normalization, return as-is
        return modelId;
      }

      // For models without prefix, look up provider and construct the string
      const modelDef = getModelById(modelId);
      if (modelDef) {
        return `${modelDef.provider}/${modelId}`;
      }

      // No mapping found
      return null;
  }
}

/**
 * Character-based token estimation fallback: 1 token ≈ 4 characters
 */
export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}
