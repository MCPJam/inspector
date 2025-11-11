import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createXai } from "@ai-sdk/xai";
import { LlmsConfig } from "./validators";
import { LanguageModel, ToolSet, TypedToolCall } from "ai";

export const createLlmModel = (
  provider: string,
  model: string,
  llmsConfig: LlmsConfig,
): LanguageModel | undefined => {
  const apiKey = llmsConfig[provider];
  if (!apiKey) {
    throw new Error(`LLM API key not found for provider: ${provider}`);
  }
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "deepseek":
      return createDeepSeek({ apiKey })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(model);
    case "mistral":
      return createMistral({ apiKey })(model);
    case "openrouter":
      return createOpenRouter({ apiKey })(model);
    case "xai":
      return createXai({ apiKey })(model);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
};

export const extractToolNamesAsArray = (
  toolCalls: TypedToolCall<ToolSet>[],
) => {
  return toolCalls.map((toolCall) => toolCall.toolName);
};
