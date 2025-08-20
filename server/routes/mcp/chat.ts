import { Hono } from "hono";
import {
  validateMultipleServerConfigs,
  createMCPClientWithMultipleConnections,
  normalizeServerConfigName,
} from "../../utils/mcp-utils";
import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";
import {
  ChatMessage,
  ModelDefinition,
  ModelProvider,
} from "../../../shared/types";
import { MCPClient } from "@mastra/mcp";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { TextEncoder } from "util";
import { getDefaultTemperatureByProvider } from "../../../client/src/lib/chat-utils";

// Types
interface ElicitationRequest {
  message: string;
  requestedSchema: any;
}

interface ElicitationResponse {
  [key: string]: unknown;
  action: "accept" | "decline" | "cancel";
  content?: any;
  _meta?: any;
}

interface PendingElicitation {
  resolve: (response: ElicitationResponse) => void;
  reject: (error: any) => void;
}

interface StreamingContext {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  toolCallId: number;
  lastEmittedToolCallId: number | null;
}

interface ChatRequest {
  serverConfigs?: Record<string, any>;
  model: ModelDefinition;
  provider: ModelProvider;
  apiKey?: string;
  systemPrompt?: string;
  messages?: ChatMessage[];
  ollamaBaseUrl?: string;
  action?: string;
  requestId?: string;
  response?: any;
}

// Constants
const DEBUG_ENABLED = process.env.MCP_DEBUG !== "false";
const ELICITATION_TIMEOUT = 300000; // 5 minutes
const MAX_AGENT_STEPS = 10;

// Debug logging helper
const dbg = (...args: any[]) => {
  if (DEBUG_ENABLED) console.log("[mcp/chat]", ...args);
};

// Avoid MaxListeners warnings when repeatedly creating MCP clients in dev
try {
  (process as any).setMaxListeners?.(50);
} catch {}

// Store for pending elicitation requests
const pendingElicitations = new Map<string, PendingElicitation>();

const chat = new Hono();

// Helper Functions

/**
 * Creates an LLM model based on the provider and configuration
 */
const createLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  ollamaBaseUrl?: string,
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
      return createOpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" })(
        modelDefinition.id,
      );
    case "ollama":
      const baseUrl = ollamaBaseUrl || "http://localhost:11434";
      return createOllama({
        baseURL: `${baseUrl}`,
      })(modelDefinition.id, {
        simulateStreaming: true,
      });
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
};

/**
 * Handles elicitation requests by streaming them to the client and waiting for response
 */
const createElicitationHandler = (streamingContext: StreamingContext) => {
  return async (elicitationRequest: ElicitationRequest) => {
    const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Stream elicitation request to client
    if (streamingContext.controller && streamingContext.encoder) {
      streamingContext.controller.enqueue(
        streamingContext.encoder.encode(
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

    // Return a promise that will be resolved when user responds
    return new Promise<ElicitationResponse>((resolve, reject) => {
      pendingElicitations.set(requestId, { resolve, reject });

      // Set timeout to clean up if no response
      setTimeout(() => {
        if (pendingElicitations.has(requestId)) {
          pendingElicitations.delete(requestId);
          reject(new Error("Elicitation timeout"));
        }
      }, ELICITATION_TIMEOUT);
    });
  };
};

/**
 * Wraps MCP tools to capture execution events and stream them to the client
 */
const wrapToolsWithStreaming = (
  tools: Record<string, any>,
  streamingContext: StreamingContext,
) => {
  const wrappedTools: Record<string, any> = {};

  for (const [name, tool] of Object.entries(tools)) {
    wrappedTools[name] = {
      ...(tool as any),
      execute: async (params: any) => {
        const currentToolCallId = ++streamingContext.toolCallId;
        const startedAt = Date.now();

        // Stream tool call event immediately
        if (streamingContext.controller && streamingContext.encoder) {
          streamingContext.controller.enqueue(
            streamingContext.encoder.encode(
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
          dbg("Tool result", {
            name,
            currentToolCallId,
            ms: Date.now() - startedAt,
          });

          // Stream tool result event
          if (streamingContext.controller && streamingContext.encoder) {
            streamingContext.controller.enqueue(
              streamingContext.encoder.encode(
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
          dbg("Tool error", {
            name,
            currentToolCallId,
            error: error instanceof Error ? error.message : String(error),
          });

          // Stream tool error event
          if (streamingContext.controller && streamingContext.encoder) {
            streamingContext.controller.enqueue(
              streamingContext.encoder.encode(
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

  return wrappedTools;
};

/**
 * Handles tool call and result events from the agent's onStepFinish callback
 */
const handleAgentStepFinish = (
  streamingContext: StreamingContext,
  text: string,
  toolCalls: any[] | undefined,
  toolResults: any[] | undefined,
) => {
  try {
    // Handle tool calls
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const currentToolCallId = ++streamingContext.toolCallId;
        streamingContext.lastEmittedToolCallId = currentToolCallId;

        if (streamingContext.controller && streamingContext.encoder) {
          streamingContext.controller.enqueue(
            streamingContext.encoder.encode(
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

    // Handle tool results
    if (toolResults && Array.isArray(toolResults)) {
      for (const result of toolResults) {
        const currentToolCallId =
          streamingContext.lastEmittedToolCallId != null
            ? streamingContext.lastEmittedToolCallId
            : ++streamingContext.toolCallId;

        if (streamingContext.controller && streamingContext.encoder) {
          streamingContext.controller.enqueue(
            streamingContext.encoder.encode(
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
};

/**
 * Streams text content from the agent's response
 */
const streamAgentResponse = async (
  streamingContext: StreamingContext,
  stream: any,
) => {
  let hasContent = false;
  let chunkCount = 0;

  for await (const chunk of stream.textStream) {
    if (chunk && chunk.trim()) {
      hasContent = true;
      chunkCount++;
      streamingContext.controller.enqueue(
        streamingContext.encoder!.encode(
          `data: ${JSON.stringify({ type: "text", content: chunk })}\n\n`,
        ),
      );
    }
  }

  dbg("Streaming finished", { hasContent, chunkCount });
  return { hasContent, chunkCount };
};

/**
 * Falls back to regular completion when streaming fails
 */
const fallbackToCompletion = async (
  agent: Agent,
  messages: any[],
  streamingContext: StreamingContext,
  provider: ModelProvider,
) => {
  try {
    const result = await agent.generate(messages, {
      temperature: getDefaultTemperatureByProvider(provider),
    });
    if (result.text && result.text.trim()) {
      streamingContext.controller.enqueue(
        streamingContext.encoder!.encode(
          `data: ${JSON.stringify({
            type: "text",
            content: result.text,
          })}\n\n`,
        ),
      );
    }
  } catch (fallbackErr) {
    streamingContext.controller.enqueue(
      streamingContext.encoder!.encode(
        `data: ${JSON.stringify({
          type: "text",
          content: "Failed to generate response. Please try again. ",
          error:
            fallbackErr instanceof Error
              ? fallbackErr.message
              : "Unknown error",
        })}\n\n`,
      ),
    );
  }
};

/**
 * Safely disconnects an MCP client
 */
const safeDisconnect = async (client: MCPClient | null) => {
  if (client) {
    try {
      await client.disconnect();
    } catch (cleanupError) {
      console.warn("[mcp/chat] Error cleaning up MCP client:", cleanupError);
    }
  }
};

/**
 * Creates the streaming response for the chat
 */
const createStreamingResponse = async (
  agent: Agent,
  messages: any[],
  toolsets: any,
  streamingContext: StreamingContext,
  provider: ModelProvider,
) => {
  const stream = await agent.stream(messages, {
    maxSteps: MAX_AGENT_STEPS,
    temperature: getDefaultTemperatureByProvider(provider),
    toolsets,
    onStepFinish: ({ text, toolCalls, toolResults }) => {
      handleAgentStepFinish(streamingContext, text, toolCalls, toolResults);
    },
  });

  const { hasContent } = await streamAgentResponse(streamingContext, stream);

  // Fall back to completion if no content was streamed
  if (!hasContent) {
    dbg("No content from textStream; falling back to completion");
    await fallbackToCompletion(agent, messages, streamingContext, provider);
  }

  // Stream elicitation completion
  streamingContext.controller.enqueue(
    streamingContext.encoder!.encode(
      `data: ${JSON.stringify({
        type: "elicitation_complete",
      })}\n\n`,
    ),
  );

  // End stream
  streamingContext.controller.enqueue(
    streamingContext.encoder!.encode(`data: [DONE]\n\n`),
  );
};

// Main chat endpoint
chat.post("/", async (c) => {
  let client: MCPClient | null = null;

  try {
    const requestData: ChatRequest = await c.req.json();
    const {
      serverConfigs,
      model,
      provider,
      apiKey,
      systemPrompt,
      messages,
      ollamaBaseUrl,
      action,
      requestId,
      response,
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

      pending.resolve(response);
      pendingElicitations.delete(requestId);
      return c.json({ success: true });
    }

    // Validate required parameters
    if (!model?.id || !apiKey || !messages) {
      return c.json(
        {
          success: false,
          error: "model (with id), apiKey, and messages are required",
        },
        400,
      );
    }

    // Validate and create MCP client
    if (!serverConfigs || Object.keys(serverConfigs).length === 0) {
      return c.json(
        {
          success: false,
          error: "No server configs provided",
        },
        400,
      );
    }

    const validation = validateMultipleServerConfigs(serverConfigs);
    if (!validation.success) {
      dbg(
        "Server config validation failed",
        validation.errors || validation.error,
      );
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

    // Create LLM model
    const llmModel = createLlmModel(model, apiKey, ollamaBaseUrl);
    const tools = await client.getTools();

    // Create agent without tools initially - we'll add them in the streaming context
    const agent = new Agent({
      name: "MCP Chat Agent",
      instructions:
        systemPrompt || "You are a helpful assistant with access to MCP tools.",
      model: llmModel,
      tools: undefined, // Start without tools, add them in streaming context
    });

    const formattedMessages = messages.map((msg: ChatMessage) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Get toolsets for dynamic tool resolution
    const toolsets = await client.getToolsets();
    dbg("Streaming start", {
      toolsetServers: Object.keys(toolsets),
      messageCount: formattedMessages.length,
    });

    // Create streaming response
    const encoder = new TextEncoder();
    const readableStream = new ReadableStream({
      async start(controller) {
        const streamingContext: StreamingContext = {
          controller,
          encoder,
          toolCallId: 0,
          lastEmittedToolCallId: null,
        };

        // Create streaming-wrapped tools
        const streamingWrappedTools = wrapToolsWithStreaming(
          tools,
          streamingContext,
        );

        // Create a new agent instance with streaming tools since tools property is read-only
        const streamingAgent = new Agent({
          name: agent.name,
          instructions: agent.instructions,
          model: agent.model!,
          tools:
            Object.keys(streamingWrappedTools).length > 0
              ? streamingWrappedTools
              : undefined,
        });

        // Register elicitation handler
        if (client?.elicitation?.onRequest) {
          for (const serverName of Object.keys(serverConfigs)) {
            const normalizedName = normalizeServerConfigName(serverName);
            const elicitationHandler =
              createElicitationHandler(streamingContext);
            client.elicitation.onRequest(normalizedName, elicitationHandler);
          }
        }

        try {
          if (client) {
            await createStreamingResponse(
              streamingAgent,
              formattedMessages,
              toolsets,
              streamingContext,
              provider,
            );
          } else {
            throw new Error("MCP client is null");
          }
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "error",
                error: error instanceof Error ? error.message : "Unknown error",
              })}\n\n`,
            ),
          );
        } finally {
          await safeDisconnect(client);
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
    await safeDisconnect(client);

    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default chat;
