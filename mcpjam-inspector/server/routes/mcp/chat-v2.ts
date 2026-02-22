import { Hono } from "hono";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type ToolSet,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import { isMCPJamProvidedModel } from "@/shared/types";
import type { ModelProvider } from "@/shared/types";
import { logger } from "../../utils/logger";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration";

const PROVIDER_DISPLAY_NAMES: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  azure: "Azure OpenAI",
  deepseek: "DeepSeek",
  google: "Google",
  meta: "Meta",
  mistral: "Mistral",
  minimax: "MiniMax",
  moonshotai: "Moonshot AI",
  xai: "xAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "z-ai": "Zhipu AI",
  custom: "your custom provider",
};

function formatStreamError(error: unknown, provider?: ModelProvider): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Duck-type statusCode/responseBody — APICallError.isInstance() can fail
  // when multiple copies of @ai-sdk/provider are bundled (symbol mismatch).
  const statusCode = (error as any).statusCode as number | undefined;
  const responseBody = (error as any).responseBody as string | undefined;

  // Detect auth/permission errors from AI provider APIs
  if (
    typeof statusCode === "number" &&
    (statusCode === 401 || statusCode === 403)
  ) {
    const providerName =
      (provider && PROVIDER_DISPLAY_NAMES[provider]) || "your AI provider";

    return JSON.stringify({
      code: "auth_error",
      message: `Invalid API key for ${providerName}. Please check your key under LLM Providers in Settings.`,
      statusCode,
    });
  }

  // For non-auth API errors, include the response body as details
  if (responseBody && typeof responseBody === "string") {
    return JSON.stringify({
      message: error.message,
      details: responseBody,
    });
  }

  return error.message;
}

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as ChatV2Request;
    const mcpClientManager = c.mcpClientManager;
    const {
      messages,
      apiKey,
      model,
      systemPrompt,
      temperature,
      selectedServers,
      requireToolApproval,
    } = body;

    // Validation
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      return c.json({ error: "model is not supported" }, 400);
    }

    let prepared;
    try {
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt,
        temperature,
        requireToolApproval,
        customProviders: body.customProviders,
      });
    } catch (error) {
      // prepareChatV2 throws on Anthropic validation errors — return 400.
      // All other errors (e.g. getToolsForAiSdk failure) propagate to the
      // outer catch which returns 500.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Invalid tool name(s) for Anthropic")) {
        return c.json({ error: msg }, 400);
      }
      throw error;
    }

    const {
      allTools,
      enhancedSystemPrompt,
      resolvedTemperature,
      scrubMessages,
    } = prepared;

    // MCPJam-provided models: delegate to stream handler
    if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500,
        );
      }

      const modelMessages = await convertToModelMessages(messages);

      return handleMCPJamFreeChatModel({
        messages: scrubMessages(modelMessages as ModelMessage[]),
        modelId: String(modelDefinition.id),
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        authHeader: c.req.header("authorization"),
        mcpClientManager,
        selectedServers,
        requireToolApproval,
      });
    }

    // User-provided models: direct streamText
    const llmModel = createLlmModel(
      modelDefinition,
      apiKey ?? "",
      {
        ollama: body.ollamaBaseUrl,
        azure: body.azureBaseUrl,
      },
      body.customProviders,
    );

    const modelMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: llmModel,
      messages: scrubMessages(modelMessages as ModelMessage[]),
      ...(resolvedTemperature !== undefined
        ? { temperature: resolvedTemperature }
        : {}),
      system: enhancedSystemPrompt,
      tools: allTools as ToolSet,
      stopWhen: stepCountIs(20),
    });

    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") {
          return {
            inputTokens: part.usage.inputTokens,
            outputTokens: part.usage.outputTokens,
            totalTokens: part.usage.totalTokens,
          };
        }
      },
      onError: (error) => {
        logger.error("[mcp/chat-v2] stream error", error);
        return formatStreamError(error, modelDefinition.provider);
      },
    });
  } catch (error) {
    logger.error("[mcp/chat-v2] failed to process chat request", error);
    return c.json({ error: "Unexpected error" }, 500);
  }
});

export default chatV2;
