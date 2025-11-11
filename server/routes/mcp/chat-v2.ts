import { Hono } from "hono";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import { isGPT5Model, isMCPJamProvidedModel } from "@/shared/types";
import zodToJsonSchema from "zod-to-json-schema";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "@/shared/http-tool-calls";

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

      // Build tool defs once from MCP tools
      const flattenedTools = mcpTools as Record<string, any>;
      const toolDefs: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }> = [];
      for (const [name, tool] of Object.entries(flattenedTools)) {
        if (!tool) continue;
        let serializedSchema: Record<string, unknown> | undefined;
        const schema = (tool as any).inputSchema;
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
              serializedSchema = zodToJsonSchema(schema) as Record<
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
      let messageHistory = convertToModelMessages(messages);
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
                messages: JSON.stringify(messageHistory),
                model: String(modelDefinition.id),
                systemPrompt,
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

            // Parse SSE stream from Convex
            const reader = res.body?.getReader();
            if (!reader) {
              writer.write({
                type: "error",
                errorText: "No response body",
              } as any);
              break;
            }

            const decoder = new TextDecoder();
            let buffer = "";
            let currentText = "";
            let hasToolCalls = false;
            let stepMetadata: any;
            let isFinished = false;

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const data = line.slice(6).trim();
                  if (!data) continue;
                  if (data === "[DONE]") {
                    isFinished = true;
                    continue;
                  }

                  try {
                    const event = JSON.parse(data);

                    // Forward stream events to client
                    if (
                      event.type === "text-start" ||
                      event.type === "text-delta" ||
                      event.type === "text-end"
                    ) {
                      writer.write(event);
                      if (event.type === "text-delta") {
                        currentText += event.delta;
                      }
                    } else if (
                      event.type === "tool-call-start" ||
                      event.type === "tool-call" ||
                      event.type === "tool-call-delta"
                    ) {
                      writer.write(event);
                      hasToolCalls = true;
                    } else if (event.type === "finish") {
                      // Capture metadata from finish event
                      stepMetadata = event.messageMetadata;
                      // Forward finish event with metadata to client
                      writer.write({
                        type: "finish",
                        messageMetadata: stepMetadata,
                      } as any);
                    } else if (
                      event.type === "start" ||
                      event.type === "start-step" ||
                      event.type === "finish-step"
                    ) {
                      // Forward control events
                      writer.write(event);
                    }
                  } catch (e) {
                    console.warn("[chat-v2] Failed to parse SSE event:", data);
                  }
                }
              }
            } finally {
              reader.releaseLock();
            }

            // Build message from accumulated text/tool calls
            const assistantMessage: any = {
              role: "assistant",
              content: [],
            };

            if (currentText) {
              assistantMessage.content.push({
                type: "text",
                text: currentText,
              });
            }

            if (assistantMessage.content.length > 0) {
              messageHistory.push(assistantMessage);
            }

            steps++;

            // Continue if there were tool calls
            if (!hasToolCalls || isFinished) {
              break;
            }
          }
        },
      });

      return createUIMessageStreamResponse({ stream });
    }

    const llmModel = createLlmModel(
      modelDefinition,
      apiKey ?? "",
      body.ollamaBaseUrl,
      body.litellmBaseUrl,
    );

    const result = streamText({
      model: llmModel,
      messages: convertToModelMessages(messages),
      ...(resolvedTemperature == undefined
        ? {}
        : { temperature: resolvedTemperature }),
      system: systemPrompt,
      tools: mcpTools,
      stopWhen: stepCountIs(20),
    });

    return result.toUIMessageStreamResponse({
      messageMetadata: ({ part }) => {
        if (part.type === "finish") {
          return {
            inputTokens: part.totalUsage.inputTokens,
            outputTokens: part.totalUsage.outputTokens,
            totalTokens: part.totalUsage.totalTokens,
          };
        }
      },
      onError: (error) => {
        console.error("[mcp/chat-v2] stream error:", error);
        // Return detailed error message to be sent to the client
        if (error instanceof Error) {
          return error.message;
        }
        return String(error);
      },
    });
  } catch (error) {
    console.error("[mcp/chat-v2] failed to process chat request", error);
    return c.json({ error: "Unexpected error" }, 500);
  }
});

export default chatV2;
