import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { LlmsConfig } from "./validators";
import { LanguageModel, ToolSet, TypedToolCall } from "ai";
import { Logger } from "./logger";

export const createLlmModel = (
  provider: string,
  model: string,
  llmsConfig: LlmsConfig,
): LanguageModel | undefined => {
  if (!llmsConfig[provider]) {
    Logger.errorWithExit(`LLM API key not found for provider: ${provider}`);
  }
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: llmsConfig.anthropic })(model);
    case "openai":
      return createOpenAI({ apiKey: llmsConfig.openai })(model);
    case "openrouter":
      return createOpenRouter({ apiKey: llmsConfig.openrouter })(model);
    default:
      Logger.errorWithExit(`Unsupported provider: ${provider}`);
  }
};

export const extractToolNamesAsArray = (
  toolCalls: TypedToolCall<ToolSet>[],
) => {
  return toolCalls.map((toolCall) => toolCall.toolName);
};
