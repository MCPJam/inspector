import { Hono } from "hono";
import { Agent } from "@mastra/core/agent";
import {
  ChatMessage,
  ModelDefinition,
  ModelProvider,
} from "../../../shared/types";
import { TextEncoder } from "util";
import { getDefaultTemperatureByProvider } from "../../../client/src/lib/chat-utils";
// removed stepCountIs; streamVNext uses maxSteps in this codepath
import { createLlmModel } from "../../utils/chat-helpers";
import { SSEvent } from "../../../shared/sse";

// Types
interface ElicitationResponse {
  [key: string]: unknown;
  action: "accept" | "decline" | "cancel";
  content?: any;
  _meta?: any;
}

interface StreamingContext {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  toolCallId: number;
  lastEmittedToolCallId: number | null;
  stepIndex: number;
}

interface ChatRequest {
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

const chat = new Hono();

// Small helper to send one SSE event consistently
const sendSseEvent = (
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  event: SSEvent | "[DONE]",
) => {
  try {
    const payload = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
    controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
  } catch (err) {
    // Swallow errors if controller is already closed (race with onStepFinish)
    const code = (err as any)?.code;
    const msg = (err as any)?.message || "";
    if (code !== "ERR_INVALID_STATE" && !/Invalid state: Controller is already closed/.test(msg)) {
      throw err;
    }
  }
};

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
          sendSseEvent(streamingContext.controller, streamingContext.encoder, {
            type: "tool_call",
            toolCall: {
              id: currentToolCallId,
              name: call.name || call.toolName,
              parameters: call.params || call.args || {},
              timestamp: new Date().toISOString(),
              status: "executing",
            },
          });
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
          sendSseEvent(streamingContext.controller, streamingContext.encoder, {
            type: "tool_result",
            toolResult: {
              id: currentToolCallId,
              toolCallId: currentToolCallId,
              result: result.result,
              error: (result as any).error,
              timestamp: new Date().toISOString(),
            },
          });
        }
      }
    }

    // Emit a consolidated trace step event for UI tracing panels
    streamingContext.stepIndex = (streamingContext.stepIndex || 0) + 1;
    if (streamingContext.controller && streamingContext.encoder) {
      sendSseEvent(streamingContext.controller, streamingContext.encoder, {
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
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    const code = (err as any)?.code;
    const msg = (err as any)?.message || "";
    if (code !== "ERR_INVALID_STATE" && !/Invalid state: Controller is already closed/.test(msg)) {
      dbg("onStepFinish error", err);
    }
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
      sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
        type: "text",
        content: chunk.textDelta,
      });
    }

    // Handle tool calls from streamVNext
    if (chunk.type === "tool-call" && chunk.toolName) {
      const currentToolCallId = ++streamingContext.toolCallId;
      sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
        type: "tool_call",
        toolCall: {
          id: currentToolCallId,
          name: chunk.toolName,
          parameters: chunk.args || {},
          timestamp: new Date().toISOString(),
          status: "executing",
        },
      });
    }

    // Handle tool results from streamVNext
    if (chunk.type === "tool-result" && chunk.result !== undefined) {
      const currentToolCallId = streamingContext.toolCallId;
      sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
        type: "tool_result",
        toolResult: {
          id: currentToolCallId,
          toolCallId: currentToolCallId,
          result: chunk.result,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Handle errors from streamVNext
    if (chunk.type === "error" && chunk.error) {
      sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
        type: "error",
        error:
          chunk.error instanceof Error
            ? chunk.error.message
            : String(chunk.error),
      });
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
  messages: ChatMessage[],
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
      sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
        type: "text",
        content: result.text,
      });
    }
  } catch (fallbackErr) {
    sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
      type: "error",
      error:
        fallbackErr instanceof Error ? fallbackErr.message : "Unknown error",
    });
  }
};

/**
 * Falls back to the regular stream method for V1 models
 */
const fallbackToStreamV1Method = async (
  agent: Agent,
  messages: ChatMessage[],
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
        sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
          type: "text",
          content: chunk,
        });
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

const createStreamingResponse = async (
  agent: Agent,
  messages: ChatMessage[],
  streamingContext: StreamingContext,
  provider: ModelProvider,
  temperature?: number,
) => {
  try {
    // Try streamVNext first (works with AI SDK v2 models)
    const stream = await agent.streamVNext(messages, {
      maxSteps: MAX_AGENT_STEPS,
      onStepFinish: ({ text, toolCalls, toolResults }) => {
        handleAgentStepFinish(streamingContext, text, toolCalls, toolResults);
      },
    });

    const { hasContent } = await streamAgentResponse(streamingContext, stream);

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
        streamingContext,
        provider,
        temperature,
      );
    } else {
      throw error;
    }
  }

  // Stream elicitation completion
  sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
    type: "elicitation_complete",
  });

  // End stream
  sendSseEvent(
    streamingContext.controller,
    streamingContext.encoder!,
    "[DONE]",
  );
};

// Main chat endpoint
chat.post("/", async (c) => {
  const mcpClientManager = c.mcpJamClientManager;
  try {
    const requestData: ChatRequest = await c.req.json();
    const {
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

      const success = mcpClientManager.respondToElicitation(
        requestId,
        response,
      );
      if (!success) {
        return c.json(
          {
            success: false,
            error: "No pending elicitation found for this requestId",
          },
          404,
        );
      }

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

    // Create LLM model
    const llmModel = createLlmModel(model, apiKey, ollamaBaseUrl);

    const toolsets =
      await mcpClientManager.getFlattenedToolsetsForEnabledServers();

    const agent = new Agent({
      name: "MCP Chat Agent",
      instructions:
        systemPrompt || "You are a helpful assistant with access to MCP tools.",
      model: llmModel,
      tools: toolsets,
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
            sendSseEvent(
              streamingContext.controller,
              streamingContext.encoder,
              {
                type: "elicitation_request",
                requestId: request.requestId,
                message: elicitationRequest.message,
                schema: elicitationRequest.requestedSchema,
                timestamp: new Date().toISOString(),
              },
            );
          }

          // Return a promise that will be resolved when user responds
          return new Promise<ElicitationResponse>((resolve, reject) => {
            // Set timeout to clean up if no response
            const timeout = setTimeout(() => {
              reject(new Error("Elicitation timeout"));
            }, ELICITATION_TIMEOUT);

            // Store the resolver in the manager's pending elicitations
            mcpClientManager.getPendingElicitations().set(request.requestId, {
              resolve: (response: ElicitationResponse) => {
                clearTimeout(timeout);
                resolve(response);
              },
              reject: (error: any) => {
                clearTimeout(timeout);
                reject(error);
              },
            });
          });
        });

        try {
          await createStreamingResponse(
            agent,
            messages,
            streamingContext,
            provider,
            temperature,
          );
        } catch (error) {
          sendSseEvent(controller, encoder, {
            type: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          });
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
