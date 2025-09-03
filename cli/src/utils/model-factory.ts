import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { ModelError } from "./test-errors.js";

interface ModelConfig {
  id: string;
  provider: string;
}

interface ProviderApiKeys {
  anthropic?: string;
  openai?: string;
  deepseek?: string;
}

const MODEL_CREATORS = {
  anthropic: (apiKey: string, modelId: string) =>
    createAnthropic({ apiKey })(modelId),
  openai: (apiKey: string, modelId: string) =>
    createOpenAI({ apiKey })(modelId),
  deepseek: (apiKey: string, modelId: string) =>
    createOpenAI({
      apiKey,
      baseURL: "https://api.deepseek.com/v1",
    })(modelId),
  ollama: (_: string, modelId: string) =>
    createOllama({
      baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/api",
    })(modelId),
};

const ENV_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

export function createModel(
  modelConfig: ModelConfig,
  providerApiKeys: ProviderApiKeys = {},
) {
  const { provider, id: modelId } = modelConfig;

  if (!(provider in MODEL_CREATORS)) {
    throw new ModelError(
      provider,
      modelId,
      `Unsupported provider: ${provider}`,
    );
  }

  try {
    let apiKey: string | undefined;

    if (provider !== "ollama") {
      apiKey =
        providerApiKeys[provider as keyof ProviderApiKeys] ||
        process.env[ENV_KEYS[provider as keyof typeof ENV_KEYS]];

      if (!apiKey) {
        throw new Error(
          `Missing ${provider.toUpperCase()} API key. Set ${ENV_KEYS[provider as keyof typeof ENV_KEYS]} environment variable or provide in environment file.`,
        );
      }
    }

    const creator = MODEL_CREATORS[provider as keyof typeof MODEL_CREATORS];
    return creator(apiKey || "", modelId);
  } catch (error) {
    throw new ModelError(
      provider,
      modelId,
      (error as Error)?.message || "Unknown error",
    );
  }
}
