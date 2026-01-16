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
import { logger } from "../../utils/logger";

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
                mode: "step",
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

            const json: any = await res.json();
            if (!json?.ok || !Array.isArray(json.messages)) {
              break;
            }

            for (const m of json.messages as any[]) {
              if (m?.role === "assistant" && Array.isArray(m.content)) {
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
              await executeToolCallsFromMessages(messageHistory, {
                clientManager: mcpClientManager,
              });
            }
            const newMessages = messageHistory.slice(beforeLen);
            for (const msg of newMessages) {
              if (msg?.role === "tool" && Array.isArray((msg as any).content)) {
                for (const item of (msg as any).content) {
                  if (item?.type === "tool-result") {
                    writer.write({
                      type: "tool-output-available",
                      toolCallId: item.toolCallId,
                      output: item.output ?? item.result ?? item.value,
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

    const llmModel = createLlmModel(
      modelDefinition,
      apiKey ?? "",
      body.ollamaBaseUrl,
      body.litellmBaseUrl,
      body.azureBaseUrl,
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
