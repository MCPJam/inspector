import { Hono } from "hono";
import { Agent } from "@mastra/core/agent";
import {
  ChatMessage,
  ModelDefinition,
  ModelProvider,
} from "../../../shared/types";
import { TextEncoder } from "util";
import { getDefaultTemperatureByProvider } from "../../../client/src/lib/chat-utils";
import { stepCountIs } from "ai-v5";
import { createLlmModel } from "utils/chat-helpers";

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
  temperature?: number;
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

try {
  (process as any).setMaxListeners?.(50);
} catch {}

const pendingElicitations = new Map<string, PendingElicitation>();
const chat = new Hono();

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
 * Streams content from the agent's streamVNext response
 */
const streamAgentResponse = async (
  streamingContext: StreamingContext,
  stream: any,
) => {
  let hasContent = false;
  let chunkCount = 0;

  for await (const chunk of stream.fullStream) {
    chunkCount++;

    // Handle text content
    if (chunk.type === "text-delta" && chunk.textDelta) {
      hasContent = true;
      streamingContext.controller.enqueue(
        streamingContext.encoder!.encode(
          `data: ${JSON.stringify({ type: "text", content: chunk.textDelta })}\n\n`,
        ),
      );
    }

    // Handle tool calls from streamVNext
    if (chunk.type === "tool-call" && chunk.toolName) {
      const currentToolCallId = ++streamingContext.toolCallId;
      streamingContext.controller.enqueue(
        streamingContext.encoder!.encode(
          `data: ${JSON.stringify({
            type: "tool_call",
            toolCall: {
              id: currentToolCallId,
              name: chunk.toolName,
              parameters: chunk.args || {},
              timestamp: new Date(),
              status: "executing",
            },
          })}\n\n`,
        ),
      );
    }

    // Handle tool results from streamVNext
    if (chunk.type === "tool-result" && chunk.result !== undefined) {
      const currentToolCallId = streamingContext.toolCallId;
      streamingContext.controller.enqueue(
        streamingContext.encoder!.encode(
          `data: ${JSON.stringify({
            type: "tool_result",
            toolResult: {
              id: currentToolCallId,
              toolCallId: currentToolCallId,
              result: chunk.result,
              timestamp: new Date(),
            },
          })}\n\n`,
        ),
      );
    }

    // Handle errors from streamVNext
    if (chunk.type === "error" && chunk.error) {
      streamingContext.controller.enqueue(
        streamingContext.encoder!.encode(
          `data: ${JSON.stringify({
            type: "error",
            error:
              chunk.error instanceof Error
                ? chunk.error.message
                : String(chunk.error),
          })}\n\n`,
        ),
      );
    }

    // Handle finish event
    if (chunk.type === "finish") {
      // Stream completion will be handled by the main function
      break;
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
  temperature?: number,
) => {
  try {
    const result = await agent.generate(messages, {
      temperature:
        temperature == null || undefined
          ? getDefaultTemperatureByProvider(provider)
          : temperature,
    });
    console.log("result", result);
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
          type: "error",
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
 * Falls back to the regular stream method for V1 models
 */
const fallbackToStreamV1Method = async (
  agent: Agent,
  messages: any[],
  toolsets: any,
  streamingContext: StreamingContext,
  provider: ModelProvider,
  temperature?: number,
) => {
  try {
    const stream = await agent.stream(messages, {
      maxSteps: MAX_AGENT_STEPS,
      temperature:
        temperature == null || undefined
          ? getDefaultTemperatureByProvider(provider)
          : temperature,
      toolsets,
      onStepFinish: ({ text, toolCalls, toolResults }) => {
        handleAgentStepFinish(streamingContext, text, toolCalls, toolResults);
      },
    });

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

    dbg("Stream method finished", { hasContent, chunkCount });

    // Fall back to completion if no content was streamed
    if (!hasContent) {
      dbg("No content from textStream; falling back to completion");
      await fallbackToCompletion(
        agent,
        messages,
        streamingContext,
        provider,
        temperature,
      );
    }
  } catch (streamErr) {
    dbg("Stream method failed", streamErr);
    await fallbackToCompletion(
      agent,
      messages,
      streamingContext,
      provider,
      temperature,
    );
  }
};

/**
 * Creates the streaming response for the chat using streamVNext or fallback to stream
 */
const createStreamingResponse = async (
  agent: Agent,
  messages: any[],
  toolsets: any,
  streamingContext: StreamingContext,
  provider: ModelProvider,
  temperature?: number,
) => {
  try {
    // Try streamVNext first (works with AI SDK v2 models)
    const stream = await agent.streamVNext(messages, {
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      modelSettings: {
        temperature:
          temperature == null || undefined
            ? getDefaultTemperatureByProvider(provider)
            : temperature,
      },
      toolsets,
      onStepFinish: ({ text, toolCalls, toolResults }) => {
        handleAgentStepFinish(streamingContext, text, toolCalls, toolResults);
      },
    });

    const { hasContent } = await streamAgentResponse(streamingContext, stream);

    // Fall back to completion if no content was streamed
    if (!hasContent) {
      dbg("No content from fullStream; falling back to completion");
      await fallbackToCompletion(
        agent,
        messages,
        streamingContext,
        provider,
        temperature,
      );
    }
  } catch (error) {
    // If streamVNext fails (e.g., V1 models), fall back to the regular stream method
    if (
      error instanceof Error &&
      error.message.includes("V1 models are not supported for streamVNext")
    ) {
      dbg(
        "streamVNext not supported for this model, falling back to stream method",
      );
      await fallbackToStreamV1Method(
        agent,
        messages,
        toolsets,
        streamingContext,
        provider,
        temperature,
      );
    } else {
      throw error;
    }
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
      temperature,
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

    // Flatten toolsets into a single tools object
    const flattenedTools: Record<string, any> = {};
    Object.values(toolsByServer).forEach((serverTools: any) => {
      Object.assign(flattenedTools, serverTools);
    });

    // Create agent with tools for streamVNext
    const agent = new Agent({
      name: "MCP Chat Agent",
      instructions:
        systemPrompt || "You are a helpful assistant with access to MCP tools.",
      model: llmModel,
      tools:
        Object.keys(flattenedTools).length > 0 ? flattenedTools : undefined,
    });

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
            agent,
            formattedMessages,
            toolsByServer,
            streamingContext,
            provider,
            temperature,
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
