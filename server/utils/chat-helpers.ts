import { ModelDefinition } from "@/shared/types";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock";
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
    case "bedrock": {
      const region =
        process.env.AWS_BEDROCK_REGION ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION ||
        "us-west-2";

      const options: AmazonBedrockProviderSettings = {
        region,
      };

      if (apiKey?.trim()) {
        const trimmed = apiKey.trim();
        let accessKeyId: string | undefined;
        let secretAccessKey: string | undefined;
        let sessionToken: string | undefined;

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object") {
            accessKeyId =
              parsed.accessKeyId ||
              parsed.awsAccessKeyId ||
              parsed.AWS_ACCESS_KEY_ID;
            secretAccessKey =
              parsed.secretAccessKey ||
              parsed.awsSecretAccessKey ||
              parsed.AWS_SECRET_ACCESS_KEY;
            sessionToken =
              parsed.sessionToken ||
              parsed.awsSessionToken ||
              parsed.AWS_SESSION_TOKEN;
          }
        } catch {
          // Ignore JSON parse errors and fall back to delimiter parsing
        }

        if (!accessKeyId || !secretAccessKey) {
          const segments = trimmed.split("|").map((part) => part.trim());
          if (segments.length >= 2) {
            [accessKeyId, secretAccessKey, sessionToken] = segments;
          }
        }

        if ((!accessKeyId || !secretAccessKey) && /\r?\n/.test(trimmed)) {
          const segments = trimmed
            .split(/\r?\n/)
            .map((part) => part.trim())
            .filter(Boolean);
          if (segments.length >= 2) {
            [accessKeyId, secretAccessKey, sessionToken] = segments;
          }
        }

        if (accessKeyId && secretAccessKey) {
          options.accessKeyId = accessKeyId;
          options.secretAccessKey = secretAccessKey;
          if (sessionToken) {
            options.sessionToken = sessionToken;
          }
        } else {
          throw new Error(
            "Amazon Bedrock credentials must include an access key ID and secret access key.",
          );
        }
      }

      return createAmazonBedrock(options)(modelDefinition.id);
    }
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
