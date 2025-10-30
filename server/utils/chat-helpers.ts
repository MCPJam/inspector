import { ModelDefinition } from "@/shared/types";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";

export const createLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  ollamaBaseUrl?: string,
  litellmBaseUrl?: string,
  bedrockRegion?: string,
  bedrockSecretKey?: string,
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
    case "bedrock": {
      // Amazon Bedrock requires region and AWS credentials
      // apiKey is used as accessKeyId
      const region = bedrockRegion || process.env.AWS_REGION || "us-east-1";
      const accessKeyId = (
        apiKey ||
        process.env.AWS_ACCESS_KEY_ID ||
        ""
      ).trim();
      const secretAccessKey = (
        bedrockSecretKey ||
        process.env.AWS_SECRET_ACCESS_KEY ||
        ""
      ).trim();

      if (!accessKeyId) {
        throw new Error("AWS Access Key ID is required for Bedrock");
      }

      if (!secretAccessKey) {
        throw new Error("AWS Secret Access Key is required for Bedrock");
      }

      // Validate AWS Access Key format
      if (!accessKeyId.startsWith("AKIA") && !accessKeyId.startsWith("ASIA")) {
        throw new Error(
          "Invalid AWS Access Key ID format. It should start with AKIA or ASIA",
        );
      }

      return createAmazonBedrock({
        region: region.trim(),
        accessKeyId,
        secretAccessKey,
      })(modelDefinition.id);
    }
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
    case "openrouter":
      return createOpenRouter({ apiKey })(modelDefinition.id);
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
};
