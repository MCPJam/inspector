import { Hono } from "hono";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  ToolSet,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import { isGPT5Model, isMCPJamProvidedModel } from "@/shared/types";
import { z } from "zod";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "@/shared/http-tool-calls";
import { logger } from "../../utils/logger";
import { getSkillToolsAndPrompt } from "../../utils/skill-tools";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  scrubChatGPTAppsToolResultsForBackend,
  scrubMcpAppsToolResultsForBackend,
} from "../../utils/chat-helpers";

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

    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      return c.json({ error: "model is not supported" }, 400);
    }
    const mcpTools = await mcpClientManager.getToolsForAiSdk(selectedServers);

    // Get skill tools and system prompt section
    const { tools: skillTools, systemPromptSection: skillsPromptSection } =
      await getSkillToolsAndPrompt();

    // Merge MCP tools with skill tools
    const allTools = { ...mcpTools, ...skillTools };

    // Append skills section to system prompt
    const enhancedSystemPrompt = systemPrompt
      ? systemPrompt + skillsPromptSection
      : skillsPromptSection;

    const resolvedTemperature = isGPT5Model(modelDefinition.id)
      ? undefined
      : (temperature ?? DEFAULT_TEMPERATURE);

    // If model is MCPJam-provided, delegate to backend free-chat endpoint
    if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500,
        );
      }

      // Build tool defs from all tools (MCP + skill tools)
      const flattenedTools = allTools as Record<string, any>;
      const toolDefs: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }> = [];
      for (const [name, tool] of Object.entries(flattenedTools)) {
        if (!tool) continue;
        let serializedSchema: Record<string, unknown> | undefined;
        // AI SDK tools use 'parameters' (Zod schema), MCP tools use 'inputSchema' (JSON Schema)
        const schema = (tool as any).parameters ?? (tool as any).inputSchema;
        if (schema) {
          if (
            typeof schema === "object" &&
            schema !== null &&
            "jsonSchema" in (schema as Record<string, unknown>)
          ) {
            serializedSchema = (schema as any).jsonSchema as Record<
              string,
              unknown
            >;
          } else {
            try {
              serializedSchema = z.toJSONSchema(schema) as Record<
                string,
                unknown
              >;
            } catch {
              serializedSchema = {
                type: "object",
                properties: {},
                additionalProperties: false,
              } as any;
            }
          }
        }
        toolDefs.push({
          name,
          description: (tool as any).description,
          inputSchema:
            serializedSchema ??
            ({
              type: "object",
              properties: {},
              additionalProperties: false,
            } as any),
        });
      }

      // Driver loop that emits AI UIMessage chunks (compatible with DefaultChatTransport)
      const authHeader = c.req.header("authorization") || undefined;
      let messageHistory = scrubMcpAppsToolResultsForBackend(
        (await convertToModelMessages(messages)) as ModelMessage[],
        mcpClientManager,
        selectedServers,
      );
      messageHistory = scrubChatGPTAppsToolResultsForBackend(
        messageHistory,
        mcpClientManager,
        selectedServers,
      );
      let steps = 0;
      const MAX_STEPS = 20;

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          const msgId = `asst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

          while (steps < MAX_STEPS) {
            const res = await fetch(`${process.env.CONVEX_HTTP_URL}/stream`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(authHeader ? { authorization: authHeader } : {}),
              },
              body: JSON.stringify({
                mode: "step",
                messages: JSON.stringify(
                  scrubChatGPTAppsToolResultsForBackend(
                    scrubMcpAppsToolResultsForBackend(
                      messageHistory,
                      mcpClientManager,
                      selectedServers,
                    ),
                    mcpClientManager,
                    selectedServers,
                  ),
                ),
                model: String(modelDefinition.id),
                systemPrompt: enhancedSystemPrompt,
                ...(resolvedTemperature == undefined
                  ? {}
                  : { temperature: resolvedTemperature }),
                tools: toolDefs,
              }),
            });

            if (!res.ok) {
              const errorText = await res.text().catch(() => "step failed");
              writer.write({ type: "error", errorText } as any);
              break;
            }

            const json: any = await res.json();
            if (!json?.ok || !Array.isArray(json.messages)) {
              break;
            }

            // Track length before processing new messages to identify inherited tool calls
            const messageHistoryLenBeforeStep = messageHistory.length;

            for (const m of json.messages as any[]) {
              if (m?.role === "assistant" && Array.isArray(m.content)) {
                // Attach token usage metadata to assistant messages
                if (json.usage) {
                  m.metadata = {
                    inputTokens:
                      json.usage.inputTokens ?? json.usage.promptTokens,
                    outputTokens:
                      json.usage.outputTokens ?? json.usage.completionTokens,
                    totalTokens: json.usage.totalTokens,
                  };
                }
                for (const item of m.content) {
                  if (item?.type === "text" && typeof item.text === "string") {
                    writer.write({ type: "text-start", id: msgId } as any);
                    writer.write({
                      type: "text-delta",
                      id: msgId,
                      delta: item.text,
                    } as any);
                    writer.write({ type: "text-end", id: msgId } as any);
                  } else if (item?.type === "tool-call") {
                    // Normalize tool-call
                    if (item.input == null)
                      item.input = item.parameters ?? item.args ?? {};
                    if (!item.toolCallId)
                      item.toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    writer.write({
                      type: "tool-input-available",
                      toolCallId: item.toolCallId,
                      toolName: item.toolName ?? item.name,
                      input: item.input,
                    } as any);
                  }
                }
              }
              messageHistory.push(m);
            }

            const beforeLen = messageHistory.length;
            if (hasUnresolvedToolCalls(messageHistory as any)) {
              // Collect existing tool result IDs from message history
              const existingToolResultIds = new Set<string>();
              for (const msg of messageHistory) {
                if (
                  msg?.role === "tool" &&
                  Array.isArray((msg as any).content)
                ) {
                  for (const c of (msg as any).content) {
                    if (c?.type === "tool-result") {
                      existingToolResultIds.add(c.toolCallId);
                    }
                  }
                }
              }

              // Emit tool-input-available ONLY for inherited unresolved tool calls
              // (i.e., tool calls that existed before this step, not new ones from this step)
              // New tool calls already had tool-input-available emitted above (lines 164-169)
              for (let i = 0; i < messageHistoryLenBeforeStep; i++) {
                const msg = messageHistory[i];
                if (
                  msg?.role === "assistant" &&
                  Array.isArray((msg as any).content)
                ) {
                  for (const item of (msg as any).content) {
                    if (
                      item?.type === "tool-call" &&
                      !existingToolResultIds.has(item.toolCallId)
                    ) {
                      writer.write({
                        type: "tool-input-available",
                        toolCallId: item.toolCallId,
                        toolName: item.toolName ?? item.name,
                        input: item.input ?? item.parameters ?? item.args ?? {},
                      } as any);
                    }
                  }
                }
              }

              // Use allTools which includes both MCP tools and skill tools
              await executeToolCallsFromMessages(
                messageHistory as ModelMessage[],
                {
                  tools: allTools as Record<string, any>,
                },
              );
            }
            const newMessages = messageHistory.slice(beforeLen);
            for (const msg of newMessages) {
              if (msg?.role === "tool" && Array.isArray((msg as any).content)) {
                for (const item of (msg as any).content) {
                  if (item?.type === "tool-result") {
                    writer.write({
                      type: "tool-output-available",
                      toolCallId: item.toolCallId,
                      // Prefer full result (with _meta/structuredContent) for the UI;
                      // the scrubbed output stays in messageHistory for the LLM.
                      output: item.result ?? item.output ?? item.value,
                    } as any);
                  }
                }
              }
            }
            steps++;

            const finishReason: string | undefined = json.finishReason;
            if (finishReason && finishReason !== "tool-calls") {
              writer.write({
                type: "finish",
                messageMetadata: {
                  inputTokens: json.usage?.inputTokens ?? 0,
                  outputTokens: json.usage?.outputTokens ?? 0,
                  totalTokens: json.usage?.totalTokens ?? 0,
                },
              });
              break;
            }
          }
        },
      });

      return createUIMessageStreamResponse({ stream });
    }

    const llmModel = createLlmModel(modelDefinition, apiKey ?? "", {
      ollama: body.ollamaBaseUrl,
      litellm: body.litellmBaseUrl,
      azure: body.azureBaseUrl,
      anthropic: body.anthropicBaseUrl,
      openai: body.openaiBaseUrl,
    });

    const transformedMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: llmModel,
      messages: scrubChatGPTAppsToolResultsForBackend(
        scrubMcpAppsToolResultsForBackend(
          transformedMessages as ModelMessage[],
          mcpClientManager,
          selectedServers,
        ),
        mcpClientManager,
        selectedServers,
      ),
      ...(resolvedTemperature == undefined
        ? {}
        : { temperature: resolvedTemperature }),
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
        // Return detailed error message to be sent to the client
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
