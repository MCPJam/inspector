import { Hono } from "hono";
import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider";
import {
  ChatMessage,
  ModelDefinition,
  ModelProvider,
} from "../../../shared/types";
import { TextEncoder } from "util";
import { getDefaultTemperatureByProvider } from "../../../client/src/lib/chat-utils";

// Types
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
  stepIndex: number;
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

// Use the context-injected MCPJamClientManager (see server/index.ts middleware)

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
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelDefinition.id);
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

// Removed unused createElicitationHandler

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

    // Emit a consolidated trace step event for UI tracing panels
    streamingContext.stepIndex = (streamingContext.stepIndex || 0) + 1;
    if (streamingContext.controller && streamingContext.encoder) {
      streamingContext.controller.enqueue(
        streamingContext.encoder.encode(
          `data: ${JSON.stringify({
            type: "trace_step",
            step: streamingContext.stepIndex,
            text,
            toolCalls: (toolCalls || []).map((c: any) => ({
              name: c.name || c.toolName,
              params: c.params || c.args || {},
            })),
            toolResults: (toolResults || []).map((r: any) => ({
              result: r.result,
              error: (r as any).error,
            })),
            timestamp: new Date(),
          })}\n\n`,
        ),
      );
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
  const mcpClientManager = c.mcpJamClientManager;
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

    // Connect to servers through MCPJamClientManager
    if (!serverConfigs || Object.keys(serverConfigs).length === 0) {
      return c.json(
        {
          success: false,
          error: "No server configs provided",
        },
        400,
      );
    }

    // Connect to each server using MCPJamClientManager
    const serverErrors: Record<string, string> = {};
    const connectedServers: string[] = [];

    for (const [serverName, serverConfig] of Object.entries(serverConfigs)) {
      try {
        await mcpClientManager.connectToServer(serverName, serverConfig);
        connectedServers.push(serverName);
        dbg("Connected to server", { serverName });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        serverErrors[serverName] = errorMessage;
        dbg("Failed to connect to server", { serverName, error: errorMessage });
      }
    }

    // Check if any servers connected successfully
    if (connectedServers.length === 0) {
      return c.json(
        {
          success: false,
          error: "Failed to connect to any servers",
          details: serverErrors,
        },
        400,
      );
    }

    // Log warnings for failed connections but continue with successful ones
    if (Object.keys(serverErrors).length > 0) {
      dbg("Some servers failed to connect", {
        connectedServers,
        failedServers: Object.keys(serverErrors),
        errors: serverErrors,
      });
    }

    // Create LLM model
    const llmModel = createLlmModel(model, apiKey, ollamaBaseUrl);

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

    // Get available tools from all connected servers
    const allTools = mcpClientManager.getAvailableTools();
    const toolsByServer: Record<string, any> = {};

    // Group tools by server for the agent
    for (const tool of allTools) {
      if (!toolsByServer[tool.serverId]) {
        toolsByServer[tool.serverId] = {};
      }
      toolsByServer[tool.serverId][tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (params: any) => {
          return await mcpClientManager.executeToolDirect(
            `${tool.serverId}:${tool.name}`,
            params,
          );
        },
      };
    }

    dbg("Streaming start", {
      connectedServers,
      toolCount: allTools.length,
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
          stepIndex: 0,
        };

        // Flatten toolsets into a single tools object for streaming wrapper
        const flattenedTools: Record<string, any> = {};
        Object.values(toolsByServer).forEach((serverTools: any) => {
          Object.assign(flattenedTools, serverTools);
        });

        // Create streaming-wrapped tools
        const streamingWrappedTools = wrapToolsWithStreaming(
          flattenedTools,
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

        // Register elicitation handler with MCPJamClientManager
        mcpClientManager.setElicitationCallback(async (request) => {
          // Convert MCPJamClientManager format to createElicitationHandler format
          const elicitationRequest = {
            message: request.message,
            requestedSchema: request.schema,
          };

          // Stream elicitation request to client using the provided requestId
          if (streamingContext.controller && streamingContext.encoder) {
            streamingContext.controller.enqueue(
              streamingContext.encoder.encode(
                `data: ${JSON.stringify({
                  type: "elicitation_request",
                  requestId: request.requestId,
                  message: elicitationRequest.message,
                  schema: elicitationRequest.requestedSchema,
                  timestamp: new Date(),
                })}\n\n`,
              ),
            );
          }

          // Return a promise that will be resolved when user responds
          return new Promise<ElicitationResponse>((resolve, reject) => {
            pendingElicitations.set(request.requestId, { resolve, reject });

            // Set timeout to clean up if no response
            setTimeout(() => {
              if (pendingElicitations.has(request.requestId)) {
                pendingElicitations.delete(request.requestId);
                reject(new Error("Elicitation timeout"));
              }
            }, ELICITATION_TIMEOUT);
          });
        });

        try {
          await createStreamingResponse(
            streamingAgent,
            formattedMessages,
            toolsByServer,
            streamingContext,
            provider,
          );
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
          // Clear elicitation callback to prevent memory leaks
          mcpClientManager.clearElicitationCallback();
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

    // Clear elicitation callback on error
    mcpClientManager.clearElicitationCallback();

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
