import { Hono } from "hono";
import {
  validateMultipleServerConfigs,
  createMCPClientWithMultipleConnections,
} from "../../utils/mcp-utils";
import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import { ChatMessage, ModelDefinition } from "../../../shared/types";
import { MCPClient } from "@mastra/mcp";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { TextEncoder } from "util";

const chat = new Hono();

// Debug logging helper
const DEBUG_ENABLED = process.env.MCP_DEBUG !== "false";
const dbg = (...args: any[]) => {
  if (DEBUG_ENABLED) console.log("[mcp/chat]", ...args);
};

// Avoid MaxListeners warnings when repeatedly creating MCP clients in dev
try {
  (process as any).setMaxListeners?.(50);
} catch {}

// Store for pending elicitation requests
const pendingElicitations = new Map<
  string,
  {
    resolve: (response: any) => void;
    reject: (error: any) => void;
  }
>();

chat.post("/", async (c) => {
  let client: MCPClient | null = null;
  try {
    const requestData = await c.req.json();
    const {
      serverConfigs,
      model,
      apiKey,
      systemPrompt,
      messages,
      ollamaBaseUrl,
      action,
      requestId,
      response,
    }: {
      serverConfigs?: Record<string, any>;
      model?: ModelDefinition;
      apiKey?: string;
      systemPrompt?: string;
      messages?: ChatMessage[];
      ollamaBaseUrl?: string;
      action?: string;
      requestId?: string;
      response?: any;
    } = requestData;

    // Handle elicitation response
    if (action === "elicitation_response") {
      if (!requestId) {
        return c.json(
          {
            success: false,
            error: "requestId is required for elicitation_response action",
          },
          400,
        );
      }

      const pending = pendingElicitations.get(requestId);
      if (!pending) {
        return c.json(
          {
            success: false,
            error: "No pending elicitation found for this requestId",
          },
          404,
        );
      }

      // Resolve the pending elicitation with user's response
      pending.resolve(response);
      pendingElicitations.delete(requestId);

      return c.json({ success: true });
    }

    if (!model || !model.id || !apiKey || !messages) {
      return c.json(
        {
          success: false,
          error: "model (with id), apiKey, and messages are required",
        },
        400,
      );
    }

    dbg("Incoming chat request", {
      provider: model?.provider,
      modelId: model?.id,
      messageCount: messages?.length,
      serverCount: serverConfigs ? Object.keys(serverConfigs).length : 0,
    });

    if (serverConfigs && Object.keys(serverConfigs).length > 0) {
      const validation = validateMultipleServerConfigs(serverConfigs);
      if (!validation.success) {
        dbg("Server config validation failed", validation.errors || validation.error);
        return c.json(
          {
            success: false,
            error: validation.error!.message,
            details: validation.errors,
          },
          validation.error!.status as ContentfulStatusCode,
        );
      }

      client = createMCPClientWithMultipleConnections(validation.validConfigs!);
      dbg("Created MCP client with servers", Object.keys(validation.validConfigs!));
    } else {
      client = new MCPClient({
        id: `chat-${Date.now()}`,
        servers: {},
      });
      dbg("Created MCP client without servers");
    }

    // If we have server tools, we will request toolsets at stream-time per Mastra docs

    const llmModel = getLlmModel(model, apiKey, ollamaBaseUrl);
    dbg("LLM model initialized", { provider: model.provider, id: model.id });

    // Create a custom event emitter for streaming tool events
    let toolCallId = 0;
    let streamController: ReadableStreamDefaultController | null = null;
    let encoder: TextEncoder | null = null;
    // Tracks the most recent emitted tool_call id so subsequent tool_result
    // events in the same step can be correlated with the proper call
    let lastEmittedToolCallId: number | null = null;

    // Set up elicitation handler
    const elicitationHandler = async (elicitationRequest: any) => {
      const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

      // Stream elicitation request to client
      if (streamController && encoder) {
        streamController.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "elicitation_request",
              requestId,
              message: elicitationRequest.message,
              schema: elicitationRequest.requestedSchema,
              timestamp: new Date(),
            })}\n\n`,
          ),
        );
      }
      dbg("Elicitation requested", { requestId });

      // Return a promise that will be resolved when user responds
      return new Promise<{
        action: "accept" | "decline" | "cancel";
        content?: { [x: string]: unknown };
        _meta?: { [x: string]: unknown };
      }>((resolve, reject) => {
        pendingElicitations.set(requestId, { resolve, reject });

        // Set a timeout to clean up if no response
        setTimeout(() => {
          if (pendingElicitations.has(requestId)) {
            pendingElicitations.delete(requestId);
            reject(new Error("Elicitation timeout"));
          }
        }, 300000); // 5 minute timeout
      });
    };

    // Register elicitation handler with the client for all servers
    if (client.elicitation && client.elicitation.onRequest && serverConfigs) {
      // Register elicitation handler for each server
      for (const serverName of Object.keys(serverConfigs)) {
        // Normalize server name to match MCPClient's internal naming
        const normalizedName = serverName
          .toLowerCase()
          .replace(/[\s\-]+/g, "_")
          .replace(/[^a-z0-9_]/g, "");
        client.elicitation.onRequest(normalizedName, elicitationHandler);
        dbg("Registered elicitation handler", { serverName, normalizedName });
      }
    }

    // Wrap tools to capture tool calls and results when statically resolved
    const tools = await client.getTools();
    const originalTools = tools && Object.keys(tools).length > 0 ? tools : {};
    const wrappedTools: Record<string, any> = {};

    for (const [name, tool] of Object.entries(originalTools)) {
      wrappedTools[name] = {
        ...(tool as any),
        execute: async (params: any) => {
          const currentToolCallId = ++toolCallId;
          const startedAt = Date.now();

          // Stream tool call event immediately
          if (streamController && encoder) {
            streamController.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "tool_call",
                  toolCall: {
                    id: currentToolCallId,
                    name,
                    parameters: params,
                    timestamp: new Date(),
                    status: "executing",
                  },
                })}\n\n`,
              ),
            );
          }
          dbg("Tool executing", { name, currentToolCallId, params });

          try {
            const result = await (tool as any).execute(params);
            dbg("Tool result", { name, currentToolCallId, ms: Date.now() - startedAt });

            // Stream tool result event immediately
            if (streamController && encoder) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "tool_result",
                    toolResult: {
                      id: currentToolCallId,
                      toolCallId: currentToolCallId,
                      result,
                      timestamp: new Date(),
                    },
                  })}\n\n`,
                ),
              );
            }

            return result;
          } catch (error) {
            dbg("Tool error", { name, currentToolCallId, error: error instanceof Error ? error.message : String(error) });
            // Stream tool error event immediately
            if (streamController && encoder) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "tool_result",
                    toolResult: {
                      id: currentToolCallId,
                      toolCallId: currentToolCallId,
                      error:
                        error instanceof Error ? error.message : String(error),
                      timestamp: new Date(),
                    },
                  })}\n\n`,
                ),
              );
            }
            throw error;
          }
        },
      };
    }

    const agent = new Agent({
      name: "MCP Chat Agent",
      instructions:
        systemPrompt || "You are a helpful assistant with access to MCP tools.",
      model: llmModel,
      tools: Object.keys(wrappedTools).length > 0 ? wrappedTools : undefined,
    });

    const formattedMessages = messages.map((msg: ChatMessage) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Start streaming; prefer dynamic toolsets so tools are resolved at call-time
    const toolsets = serverConfigs ? await client.getToolsets() : undefined;
    dbg("Streaming start", {
      toolsetServers: toolsets ? Object.keys(toolsets) : [],
      messageCount: formattedMessages.length,
    });
    let streamedAnyText = false;
    const stream = await agent.stream(formattedMessages, {
      maxSteps: 10, // Allow up to 10 steps for tool usage
      toolsets,
      onStepFinish: ({ text, toolCalls, toolResults }) => {
        try {
          if (text && streamController && encoder) {
            streamedAnyText = true;
            streamController.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text", content: text })}\n\n`,
              ),
            );
          }

          const tcList = toolCalls as any[] | undefined;
          if (tcList && Array.isArray(tcList)) {
            for (const call of tcList) {
              const currentToolCallId = ++toolCallId;
              lastEmittedToolCallId = currentToolCallId;
              if (streamController && encoder) {
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "tool_call",
                      toolCall: {
                        id: currentToolCallId,
                        name: call.name || call.toolName,
                        parameters: call.params || call.args || {},
                        timestamp: new Date(),
                        status: "executing",
                      },
                    })}\n\n`,
                  ),
                );
              }
            }
          }

          const trList = toolResults as any[] | undefined;
          if (trList && Array.isArray(trList)) {
            for (const result of trList) {
              const currentToolCallId =
                lastEmittedToolCallId != null ? lastEmittedToolCallId : ++toolCallId;
              if (streamController && encoder) {
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "tool_result",
                      toolResult: {
                        id: currentToolCallId,
                        toolCallId: currentToolCallId,
                        result: result.result,
                        error: (result as any).error,
                        timestamp: new Date(),
                      },
                    })}\n\n`,
                  ),
                );
              }
            }
          }
        } catch (err) {
          dbg("onStepFinish error", err);
        }
      },
      onFinish: ({ text, finishReason }) => {
        dbg("onFinish called", { finishReason, hasText: Boolean(text) });
        try {
          if (text && streamController && encoder) {
            streamedAnyText = true;
            streamController.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "text", content: text })}\n\n`,
              ),
            );
          }
        } catch (err) {
          dbg("onFinish enqueue error", err);
        }
      },
    });

    encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        streamController = controller;

        try {
          let hasContent = false;
          let chunkCount = 0;
          for await (const chunk of stream.textStream) {
            if (chunk && chunk.trim()) {
              hasContent = true;
              chunkCount++;
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({ type: "text", content: chunk })}\n\n`,
                ),
              );
            }
          }
          dbg("Streaming finished", { hasContent, chunkCount });

          // If no content was streamed, send a fallback message
          if (!hasContent && !streamedAnyText) {
            dbg("No content from textStream/callbacks; falling back to generate()");
            try {
              const gen = await agent.generate(formattedMessages, {
                maxSteps: 10,
                toolsets,
              });
              const finalText = gen.text || "";
              if (finalText) {
                controller.enqueue(
                  encoder!.encode(
                    `data: ${JSON.stringify({ type: "text", content: finalText })}\n\n`,
                  ),
                );
              } else {
                dbg("generate() also returned empty text");
                controller.enqueue(
                  encoder!.encode(
                    `data: ${JSON.stringify({ type: "text", content: "I apologize, but I couldn't generate a response. Please try again." })}\n\n`,
                  ),
                );
              }
            } catch (fallbackErr) {
              console.error("[mcp/chat] Fallback generate() error:", fallbackErr);
              controller.enqueue(
                encoder!.encode(
                  `data: ${JSON.stringify({ type: "error", error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) })}\n\n`,
                ),
              );
            }
          }

          // Stream elicitation completion if there were any
          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: "elicitation_complete",
              })}\n\n`,
            ),
          );

          controller.enqueue(encoder!.encode(`data: [DONE]\n\n`));
        } catch (error) {
          console.error("[mcp/chat] Streaming error:", error);
          controller.enqueue(
            encoder!.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: error instanceof Error ? error.message : "Unknown error",
              })}\n\n`,
            ),
          );
        } finally {
          if (client) {
            try {
              await client.disconnect();
            } catch (cleanupError) {
              console.warn(
                "[mcp/chat] Error cleaning up MCP client after streaming:",
                cleanupError,
              );
            }
          }
          controller.close();
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[mcp/chat] Error in chat API:", error);

    // Clean up client on error
    if (client) {
      try {
        await client.disconnect();
      } catch (cleanupError) {
        console.warn("Error cleaning up MCP client after error:", cleanupError);
      }
    }

    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

const getLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  ollamaBaseUrl?: string,
) => {
  if (!modelDefinition || !modelDefinition.id || !modelDefinition.provider) {
    throw new Error(
      `Invalid model definition: ${JSON.stringify(modelDefinition)}`,
    );
  }

  switch (modelDefinition.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelDefinition.id);
    case "openai":
      return createOpenAI({ apiKey })(modelDefinition.id);
    case "ollama":
      const baseUrl = ollamaBaseUrl || "http://localhost:11434";
      return createOllama({
        // The provider expects the root Ollama URL; it internally targets the /api endpoints
        baseURL: `${baseUrl}`,
      })(modelDefinition.id, {
        simulateStreaming: true, // Enable streaming for Ollama models
      });
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
};

export default chat;
