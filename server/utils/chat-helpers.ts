import { ModelDefinition } from "@/shared/types";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";

export const createLlmModel = (
    modelDefinition: ModelDefinition,
    apiKey: string,
    ollamaBaseUrl?: string,
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
        return createOpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" })(
          modelDefinition.id,
        );
      case "google":
        return createGoogleGenerativeAI({ apiKey })(modelDefinition.id);
      case "ollama":
        const baseUrl = ollamaBaseUrl || "http://localhost:11434/api";
        return createOllama({
          baseURL: `${baseUrl}`,
        })(modelDefinition.id, {
          simulateStreaming: true,
        });
      default:
        throw new Error(
          `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
        );
    }
  };