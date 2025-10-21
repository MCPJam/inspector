import { ModelDefinition } from "@/shared/types";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider-v2";

export const createLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  ollamaBaseUrl?: string,
  litellmBaseUrl?: string,
) => {
  if (!modelDefinition?.id || !modelDefinition?.provider) {
    throw new Error(
      `Invalid model definition: ${JSON.stringify(modelDefinition)}`,
    );
  }

  switch (modelDefinition.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelDefinition.id);
    case "openai":
      return createOpenAI({ apiKey })(modelDefinition.id);
    case "deepseek":
      return createDeepSeek({ apiKey })(modelDefinition.id);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelDefinition.id);
    case "ollama": {
      const raw = ollamaBaseUrl || "http://localhost:11434/api";
      const normalized = /\/api\/?$/.test(raw)
        ? raw
        : `${raw.replace(/\/+$/, "")}/api`;
      return createOllama({ baseURL: normalized })(modelDefinition.id);
    }
    case "mistral":
      return createMistral({ apiKey })(modelDefinition.id);
    case "litellm": {
      // LiteLLM uses OpenAI-compatible endpoints (standard chat completions API)
      const baseURL = litellmBaseUrl || "http://localhost:4000";
      const openai = createOpenAI({
        apiKey: apiKey || "dummy-key", // LiteLLM may not require API key depending on setup
        baseURL,
      });
      // IMPORTANT: Use .chat() to use Chat Completions API instead of Responses API
      return openai.chat(modelDefinition.id);
    }
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
};
