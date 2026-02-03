import { Hono } from "hono";
import {
  convertToModelMessages,
  parseJsonEventStream,
  streamText,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
  ToolSet,
  uiMessageChunkSchema,
} from "ai";
import type {
  UIMessageChunk,
  TextPart,
  ToolCallPart,
  AssistantModelMessage,
  ToolModelMessage,
  ToolResultPart,
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
              };
            }
          }
        }
        toolDefs.push({
          name,
          description: (tool as any).description,
          inputSchema: serializedSchema ?? {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
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
          while (steps < MAX_STEPS) {
            // Track length before streaming to identify inherited tool calls
            const messageHistoryLenBeforeStep = messageHistory.length;
            let pendingText = "";
            const stepContentParts: Array<TextPart | ToolCallPart> = [];
            let pendingFinishChunk: UIMessageChunk | null = null;
            let sawToolCall = false;

            const flushPendingText = () => {
              if (!pendingText) return;
              stepContentParts.push({ type: "text", text: pendingText });
              pendingText = "";
            };

            const res = await fetch(`${process.env.CONVEX_HTTP_URL}/stream`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(authHeader ? { authorization: authHeader } : {}),
              },
              body: JSON.stringify({
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

            if (!res.ok || !res.body) {
              const errorText = await res.text().catch(() => "stream failed");
              writer.write({ type: "error", errorText });
              break;
            }

            const parsedStream = parseJsonEventStream({
              stream: res.body,
              schema: uiMessageChunkSchema,
            });
            const reader = parsedStream.getReader();

            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value?.success) {
                  writer.write({
                    type: "error",
                    errorText: value?.error?.message ?? "stream parse failed",
                  });
                  break;
                }

                const chunk = value.value;

                if (chunk?.type === "finish") {
                  // Buffer finish until we know we won't execute tools in this step
                  pendingFinishChunk = chunk;
                  break;
                }

                // Forward chunk to client — BUT skip tool-output events from backend stubs
                if (
                  chunk?.type === "tool-output-available" ||
                  chunk?.type === "tool-output-error"
                ) {
                  // Don't forward: backend uses stub tools (execute: () => ({})).
                  // The proxy executes real tools and emits correct tool-output below.
                  continue;
                }
                writer.write(chunk);

                if (chunk?.type === "text-start") {
                  flushPendingText();
                  continue;
                }

                if (
                  chunk?.type === "text-delta" &&
                  typeof chunk.delta === "string"
                ) {
                  pendingText += chunk.delta;
                  continue;
                }

                if (chunk?.type === "text-end") {
                  flushPendingText();
                  continue;
                }

                if (chunk?.type === "tool-input-available") {
                  flushPendingText();
                  const toolCallId =
                    chunk.toolCallId ??
                    `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                  const toolName = chunk.toolName;
                  const input = chunk.input ?? {};
                  stepContentParts.push({
                    type: "tool-call",
                    toolCallId,
                    toolName,
                    input,
                  });
                  sawToolCall = true;
                  continue;
                }
              }
            } catch (error) {
              logger.error("[mcp/chat-v2] stream parse error", error);
              writer.write({
                type: "error",
                errorText:
                  error instanceof Error ? error.message : String(error),
              });
              break;
            } finally {
              reader.releaseLock();
            }

            flushPendingText();

            if (stepContentParts.length > 0) {
              messageHistory.push({
                role: "assistant",
                content: stepContentParts,
              } as ModelMessage);
            }

            const beforeLen = messageHistory.length;
            if (hasUnresolvedToolCalls(messageHistory)) {
              // Collect existing tool result IDs from message history
              const existingToolResultIds = new Set<string>();
              for (const msg of messageHistory) {
                if (msg?.role === "tool") {
                  const toolMsg = msg as ToolModelMessage;
                  for (const c of toolMsg.content) {
                    if (c?.type === "tool-result") {
                      existingToolResultIds.add(c.toolCallId);
                    }
                  }
                }
              }

              // Emit tool-input-available ONLY for inherited unresolved tool calls
              // (i.e., tool calls that existed before this step, not new ones from this step)
              for (let i = 0; i < messageHistoryLenBeforeStep; i++) {
                const msg = messageHistory[i];
                if (msg?.role === "assistant") {
                  const assistantMsg = msg as AssistantModelMessage;
                  for (const item of assistantMsg.content) {
                    if (
                      typeof item !== "string" &&
                      item?.type === "tool-call" &&
                      !existingToolResultIds.has(item.toolCallId)
                    ) {
                      writer.write({
                        type: "tool-input-available",
                        toolCallId: item.toolCallId,
                        toolName: item.toolName,
                        input: item.input ?? {},
                      });
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

              const newMessages = messageHistory.slice(beforeLen);
              for (const msg of newMessages) {
                if (msg?.role === "tool") {
                  const toolMsg = msg as ToolModelMessage;
                  for (const item of toolMsg.content) {
                    if (item?.type === "tool-result") {
                      const resultItem = item as ToolResultPart;
                      writer.write({
                        type: "tool-output-available",
                        toolCallId: resultItem.toolCallId,
                        // Prefer full result (with _meta/structuredContent) for the UI;
                        // the scrubbed output stays in messageHistory for the LLM.
                        output: (resultItem as any).result ?? resultItem.output,
                      });
                    }
                  }
                }
              }

              steps++;
              continue;
            }

            if (pendingFinishChunk) {
              writer.write(pendingFinishChunk);
            }

            steps++;
            if (!sawToolCall) {
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
