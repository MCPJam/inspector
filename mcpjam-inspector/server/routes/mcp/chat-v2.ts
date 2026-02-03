import { Hono } from "hono";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type ToolSet,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import {
  createLlmModel,
  scrubChatGPTAppsToolResultsForBackend,
  scrubMcpAppsToolResultsForBackend,
} from "../../utils/chat-helpers";
import { isGPT5Model, isMCPJamProvidedModel } from "@/shared/types";
import { logger } from "../../utils/logger";
import { getSkillToolsAndPrompt } from "../../utils/skill-tools";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const DEFAULT_TEMPERATURE = 0.7;

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
    } = body;

    // Validation
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      return c.json({ error: "model is not supported" }, 400);
    }

    // Get all tools (MCP + skills)
    const mcpTools = await mcpClientManager.getToolsForAiSdk(selectedServers);
    const { tools: skillTools, systemPromptSection: skillsPromptSection } =
      await getSkillToolsAndPrompt();
    const allTools = { ...mcpTools, ...skillTools };

    // Build enhanced system prompt
    const enhancedSystemPrompt = systemPrompt
      ? systemPrompt + skillsPromptSection
      : skillsPromptSection;

    // Resolve temperature (GPT-5 doesn't support it)
    const resolvedTemperature = isGPT5Model(modelDefinition.id)
      ? undefined
      : (temperature ?? DEFAULT_TEMPERATURE);

    // Helper to scrub messages for backend
    const scrubMessages = (msgs: ModelMessage[]) =>
      scrubChatGPTAppsToolResultsForBackend(
        scrubMcpAppsToolResultsForBackend(
          msgs,
          mcpClientManager,
          selectedServers,
        ),
        mcpClientManager,
        selectedServers,
      );

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
      });
    }

    // User-provided models: direct streamText
    const llmModel = createLlmModel(modelDefinition, apiKey ?? "", {
      ollama: body.ollamaBaseUrl,
      litellm: body.litellmBaseUrl,
      azure: body.azureBaseUrl,
      anthropic: body.anthropicBaseUrl,
      openai: body.openaiBaseUrl,
    });

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
        if (error instanceof Error) {
          const responseBody = (error as any).responseBody;
          if (responseBody && typeof responseBody === "string") {
            return JSON.stringify({
              message: error.message,
              details: responseBody,
            });
          }
          return error.message;
        }
        return String(error);
      },
    });
  } catch (error) {
    logger.error("[mcp/chat-v2] failed to process chat request", error);
    return c.json({ error: "Unexpected error" }, 500);
  }
});

export default chatV2;
