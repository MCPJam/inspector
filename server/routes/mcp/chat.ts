import { Hono } from "hono";
import { streamText } from "ai";
import {
  ChatMessage,
  ModelDefinition,
  ModelProvider,
  isMCPJamProvidedModel,
} from "../../../shared/types";
import { TextEncoder } from "util";
import { getDefaultTemperatureByProvider } from "../../../client/src/lib/chat-utils";
import { createLlmModel } from "../../utils/chat-helpers";
import { SSEvent } from "../../../shared/sse";
import type { ModelMessage, ToolSet } from "ai";
import { executeToolCallsFromMessages } from "@/shared/http-tool-calls";
import {
  BackendToolCallEvent,
  BackendToolResultEvent,
  runBackendConversation,
} from "@/shared/backend-conversation";
import zodToJsonSchema from "zod-to-json-schema";
import { MCPClientManager } from "@/sdk";

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
  lastEmittedToolCallId: string | null;
  stepIndex: number;
  // Map tool call ID to tool name for serverId lookup
  toolCallIdToName: Map<string, string>;
}

interface ChatRequest {
  model: ModelDefinition;
  provider: ModelProvider;
  apiKey?: string;
  systemPrompt?: string;
  temperature?: number;
  messages?: ChatMessage[];
  ollamaBaseUrl?: string;
  litellmBaseUrl?: string;
  action?: string;
  requestId?: string;
  response?: any;
  sendMessagesToBackend?: boolean;
  selectedServers?: string[]; // original names from UI
}

// Constants
const ELICITATION_TIMEOUT = 300000; // 5 minutes
const MAX_AGENT_STEPS = 10;
const BACKEND_FETCH_ERROR_MESSAGE =
  "We are having difficulties processing your message right now. Please try again later.";

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
  const payload = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
  controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
};

const sendBackendErrorText = (streamingContext: StreamingContext) => {
  sendSseEvent(streamingContext.controller, streamingContext.encoder, {
    type: "text",
    content: BACKEND_FETCH_ERROR_MESSAGE,
  });
};

const sendBackendRequest = async (
  baseUrl: string,
  authHeader: string | undefined,
  body: any,
  streamingContext: StreamingContext,
): Promise<any | null> => {
  try {
    const res = await fetch(`${baseUrl}/streaming`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      sendBackendErrorText(streamingContext);
      return null;
    }

    try {
      const data = await res.json();
      return data;
    } catch {
      sendBackendErrorText(streamingContext);
      return null;
    }
  } catch {
    sendBackendErrorText(streamingContext);
    return null;
  }
};

const handleAgentStepFinish = (
  streamingContext: StreamingContext,
  text: string,
  toolCalls: any[] | undefined,
  toolResults: any[] | undefined,
  emitToolEvents: boolean = true,
) => {
  try {
    if (emitToolEvents) {
      // Handle tool calls
      if (toolCalls && Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          // Generate unique ID with timestamp and random suffix
          const currentToolCallId = `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          streamingContext.lastEmittedToolCallId = currentToolCallId;
          const toolName = call.name || call.toolName;

          // Store tool name for serverId lookup later
          streamingContext.toolCallIdToName.set(currentToolCallId, toolName);

          if (streamingContext.controller && streamingContext.encoder) {
            sendSseEvent(
              streamingContext.controller,
              streamingContext.encoder,
              {
                type: "tool_call",
                toolCall: {
                  id: currentToolCallId,
                  name: toolName,
                  parameters: call.params || call.args || {},
                  timestamp: new Date().toISOString(),
                  status: "executing",
                },
              },
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
              : `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

          if (streamingContext.controller && streamingContext.encoder) {
            sendSseEvent(
              streamingContext.controller,
              streamingContext.encoder,
              {
                type: "tool_result",
                toolResult: {
                  id: currentToolCallId,
                  toolCallId: currentToolCallId,
                  result: result.result || result,
                  error: (result as any).error,
                  timestamp: new Date().toISOString(),
                },
              },
            );
          }
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
  } catch {}
};

const createStreamingResponse = async (
  model: any,
  aiSdkTools: ToolSet,
  messages: ChatMessage[],
  streamingContext: StreamingContext,
  provider: ModelProvider,
  toolsWithServerId: Record<string, any>, // Tools with _serverId metadata attached
  temperature?: number,
  systemPrompt?: string,
) => {
  // Helper to extract serverId from tool metadata (same pattern as http-tool-calls.ts)
  const extractServerId = (toolName: string): string | undefined => {
    const tool = toolsWithServerId[toolName];
    return tool?._serverId;
  };

  const messageHistory: ModelMessage[] = (messages || []).map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content } as ModelMessage;
      case "user":
        return { role: "user", content: m.content } as ModelMessage;
      case "assistant":
        return { role: "assistant", content: m.content } as ModelMessage;
      default:
        return { role: "user", content: m.content } as ModelMessage;
    }
  });

  let steps = 0;
  let hadError = false;
  while (steps < MAX_AGENT_STEPS) {
    let accumulatedText = "";
    const iterationToolCalls: any[] = [];
    const iterationToolResults: any[] = [];

    let streamResult;
    let hadStreamError = false;
    let streamErrorMessage = "";
    let response: any = null;

    // Helper to extract clean error message from AI SDK error structures
    const extractErrorMessage = (error: any): string => {
      if (error.error && typeof error.error === "object") {
        const apiError = error.error as any;
        if (apiError.data?.error?.message) return apiError.data.error.message;
        if (apiError.responseBody) {
          try {
            const parsed = JSON.parse(apiError.responseBody);
            if (parsed.error?.message) return parsed.error.message;
          } catch {}
        }
        if (apiError.message) return apiError.message;
      }
      if (error.error instanceof Error) return error.error.message;
      return String(error.error || error.message || "Unknown error occurred");
    };

    streamResult = streamText({
      model,
      system:
        systemPrompt || "You are a helpful assistant with access to MCP tools.",
      temperature: temperature ?? getDefaultTemperatureByProvider(provider),
      tools: aiSdkTools,
      messages: messageHistory,
      onError: (error) => {
        hadStreamError = true;
        streamErrorMessage = extractErrorMessage(error);
      },
      onChunk: async (chunk) => {
        try {
          switch (chunk.chunk.type) {
            case "text-delta":
            case "reasoning-delta": {
              const text = chunk.chunk.text;
              if (text) {
                accumulatedText += text;
                sendSseEvent(
                  streamingContext.controller,
                  streamingContext.encoder!,
                  {
                    type: "text",
                    content: text,
                  },
                );
              }
              break;
            }
            case "tool-input-start": {
              // Do not emit a tool_call for input-start; wait for the concrete tool-call
              break;
            }
            case "tool-call": {
              // Generate unique ID with timestamp and random suffix
              const currentToolCallId = `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              streamingContext.lastEmittedToolCallId = currentToolCallId;
              const name =
                (chunk.chunk as any).toolName || (chunk.chunk as any).name;
              const parameters =
                (chunk.chunk as any).input ??
                (chunk.chunk as any).parameters ??
                (chunk.chunk as any).args ??
                {};

              // Store tool name for serverId lookup later
              streamingContext.toolCallIdToName.set(currentToolCallId, name);

              iterationToolCalls.push({ name, params: parameters });
              sendSseEvent(
                streamingContext.controller,
                streamingContext.encoder!,
                {
                  type: "tool_call",
                  toolCall: {
                    id: currentToolCallId,
                    name,
                    parameters,
                    timestamp: new Date().toISOString(),
                    status: "executing",
                  },
                },
              );
              break;
            }
            case "tool-result": {
              const result =
                (chunk.chunk as any).output ??
                (chunk.chunk as any).result ??
                (chunk.chunk as any).value;
              const currentToolCallId =
                streamingContext.lastEmittedToolCallId ??
                `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              // Look up serverId from tool metadata
              const toolName =
                streamingContext.toolCallIdToName.get(currentToolCallId);
              const serverId = toolName ? extractServerId(toolName) : undefined;

              iterationToolResults.push({ result });
              sendSseEvent(
                streamingContext.controller,
                streamingContext.encoder!,
                {
                  type: "tool_result",
                  toolResult: {
                    id: currentToolCallId,
                    toolCallId: currentToolCallId,
                    result,
                    timestamp: new Date().toISOString(),
                    serverId,
                  },
                },
              );
              break;
            }
            default:
              break;
          }
        } catch (chunkError) {
          hadStreamError = true;
          streamErrorMessage =
            chunkError instanceof Error
              ? chunkError.message
              : "Error processing chunk";
        }
      },
    });

    try {
      await streamResult.consumeStream();

      // If onError was triggered, throw the extracted error message
      if (hadStreamError) {
        throw new Error(streamErrorMessage);
      }

      response = await streamResult.response;

      // Check for any additional error states in the response
      if (response.error) {
        throw response.error;
      }

      if (response.experimental_providerMetadata?.openai?.error) {
        throw new Error(
          response.experimental_providerMetadata.openai.error.message ||
            "OpenAI API error",
        );
      }
    } catch (error) {
      // Use the already-extracted error message, or extract a new one
      const errorMessage = streamErrorMessage || extractErrorMessage(error);

      sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
        type: "error",
        error: errorMessage,
      });

      sendSseEvent(
        streamingContext.controller,
        streamingContext.encoder!,
        "[DONE]",
      );

      hadError = true;
      steps++;
      break;
    }

    // If streamResult is undefined (due to error), exit the loop
    if (!streamResult || hadError) {
      steps++;
      break;
    }

    handleAgentStepFinish(
      streamingContext,
      accumulatedText,
      iterationToolCalls,
      iterationToolResults,
      false,
    );

    // Use the response we already fetched in the try block
    const responseMessages = (response?.messages || []) as ModelMessage[];
    if (responseMessages.length) {
      messageHistory.push(...responseMessages);

      // Some providers (e.g., Ollama v2) place tool outputs as ToolModelMessages
      // in the response rather than streaming a tool-result chunk.
      for (const m of responseMessages) {
        if ((m as any).role === "tool") {
          const currentToolCallId =
            streamingContext.lastEmittedToolCallId != null
              ? streamingContext.lastEmittedToolCallId
              : `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const value = (m as any).content;

          // Look up serverId from tool metadata
          const toolName =
            streamingContext.toolCallIdToName.get(currentToolCallId);
          const serverId = toolName ? extractServerId(toolName) : undefined;

          iterationToolResults.push({ result: value });
          sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
            type: "tool_result",
            toolResult: {
              id: currentToolCallId,
              toolCallId: currentToolCallId,
              result: value,
              timestamp: new Date().toISOString(),
              serverId,
            },
          });
        }
      }
    }

    steps++;

    // Get finish reason from the response we already fetched
    const finishReason = response?.finishReason || "stop";
    const shouldContinue =
      finishReason === "tool-calls" ||
      (accumulatedText.length === 0 && iterationToolResults.length > 0);

    if (!shouldContinue) break;
  }

  // Only send completion events if no error occurred
  if (!hadError) {
    sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
      type: "elicitation_complete",
    });

    sendSseEvent(
      streamingContext.controller,
      streamingContext.encoder!,
      "[DONE]",
    );
  }
};

const sendMessagesToBackend = async (
  messages: ChatMessage[],
  streamingContext: StreamingContext,
  mcpClientManager: MCPClientManager,
  baseUrl: string,
  modelId: string,
  authHeader?: string,
  selectedServers?: string[],
): Promise<void> => {
  // Build message history
  const messageHistory: ModelMessage[] = (messages || []).map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content } as ModelMessage;
      case "user":
        return { role: "user", content: m.content } as ModelMessage;
      case "assistant":
        return { role: "assistant", content: m.content } as ModelMessage;
      default:
        return { role: "user", content: m.content } as ModelMessage;
    }
  });

  const selectedServerIds =
    Array.isArray(selectedServers) && selectedServers.length > 0
      ? selectedServers
      : mcpClientManager.listServers();

  const flattenedTools = await mcpClientManager.getToolsForAiSdk(
    selectedServerIds.length > 0 ? selectedServerIds : undefined,
  );

  const toolsetsByServer: Record<string, ToolSet> = {};
  const toolDefs: any[] = [];

  for (const [name, tool] of Object.entries(flattenedTools)) {
    if (!tool) continue;

    const serverId =
      (tool as any)._serverId ??
      (selectedServerIds.length === 1 ? selectedServerIds[0] : "__unknown");

    if (!toolsetsByServer[serverId]) {
      toolsetsByServer[serverId] = {} as ToolSet;
    }
    toolsetsByServer[serverId][name] = tool;

    const schema = (tool as any).inputSchema;
    let serializedSchema: Record<string, unknown> | undefined;

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
          serializedSchema = zodToJsonSchema(schema) as Record<string, unknown>;
        } catch (err) {
          console.warn(
            `[mcp/chat] Failed to convert input schema for tool ${name}:`,
            err,
          );
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

  if (!baseUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const emitToolCall = (call: BackendToolCallEvent) => {
    // Generate unique ID with timestamp and random suffix
    const currentToolCallId = `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    streamingContext.lastEmittedToolCallId = currentToolCallId;

    // Store tool name for serverId lookup later
    streamingContext.toolCallIdToName.set(currentToolCallId, call.name);

    sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
      type: "tool_call",
      toolCall: {
        id: currentToolCallId,
        name: call.name,
        parameters: call.params as Record<string, unknown>,
        timestamp: new Date().toISOString(),
        status: "executing",
      },
    });
  };

  const emitToolResult = (result: BackendToolResultEvent) => {
    const currentToolCallId =
      streamingContext.lastEmittedToolCallId != null
        ? streamingContext.lastEmittedToolCallId
        : `tc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
      type: "tool_result",
      toolResult: {
        id: currentToolCallId,
        toolCallId: currentToolCallId,
        result: result.result,
        error: result.error as string | undefined,
        timestamp: new Date().toISOString(),
        serverId: result.serverId, // Propagate serverId
      },
    });
  };

  await runBackendConversation({
    maxSteps: MAX_AGENT_STEPS,
    messageHistory,
    modelId,
    toolDefinitions: toolDefs,
    fetchBackend: async (payload) => {
      const data = await sendBackendRequest(
        baseUrl,
        authHeader,
        payload,
        streamingContext,
      );
      if (data && (!data.ok || !Array.isArray(data.messages))) {
        sendBackendErrorText(streamingContext);
        return null;
      }
      return data;
    },
    executeToolCalls: async (messages) => {
      await executeToolCallsFromMessages(messages, {
        toolsets: toolsetsByServer as any,
      });
    },
    handlers: {
      onAssistantText: (text) => {
        sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
          type: "text",
          content: text,
        });
      },
      onToolCall: (call) => {
        emitToolCall(call);
      },
      onToolResult: (result) => {
        emitToolResult(result);
      },
      onStepComplete: ({ text, toolCalls, toolResults }) => {
        handleAgentStepFinish(
          streamingContext,
          text,
          toolCalls,
          toolResults.map((result) => ({
            result: result.result || result,
            error: result.error,
          })),
          false,
        );
      },
    },
  });

  sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
    type: "elicitation_complete",
  });
  sendSseEvent(
    streamingContext.controller,
    streamingContext.encoder!,
    "[DONE]",
  );
};

// Main chat endpoint

chat.post("/", async (c) => {
  const mcpClientManager = c.mcpClientManager;
  try {
    const requestData: ChatRequest = await c.req.json();
    const {
      model,
      provider,
      apiKey,
      systemPrompt,
      temperature,
      messages,
      ollamaBaseUrl: _ollama_unused,
      litellmBaseUrl: _litellm_unused,
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
    if (!messages) {
      return c.json(
        {
          success: false,
          error: "messages are required",
        },
        400,
      );
    }
    const sendToBackend =
      model?.id &&
      isMCPJamProvidedModel(model.id) &&
      Boolean(requestData.sendMessagesToBackend);

    if (!sendToBackend && (!model?.id || !apiKey)) {
      return c.json(
        {
          success: false,
          error: "model (with id) and apiKey are required",
        },
        400,
      );
    }

    if (sendToBackend && !process.env.CONVEX_HTTP_URL) {
      return c.json(
        {
          success: false,
          error: "Server missing CONVEX_HTTP_URL configuration",
        },
        500,
      );
    }

    // Create streaming response
    const encoder = new TextEncoder();
    const authHeader = c.req.header("authorization") || undefined;
    const readableStream = new ReadableStream({
      async start(controller) {
        const streamingContext: StreamingContext = {
          controller,
          encoder,
          toolCallId: 0,
          lastEmittedToolCallId: null,
          stepIndex: 0,
          toolCallIdToName: new Map(),
        };

        mcpClientManager.setElicitationCallback(async (request) => {
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
          if (sendToBackend) {
            await sendMessagesToBackend(
              messages,
              streamingContext,
              mcpClientManager,
              process.env.CONVEX_HTTP_URL!,
              model!.id,
              authHeader,
              requestData.selectedServers,
            );
          } else {
            // Use existing streaming path with tools
            // Get toolsets with server mapping (reusing pattern from sendMessagesToBackend)
            const toolsets = await mcpClientManager.getToolsForAiSdk(
              requestData.selectedServers,
            );

            const llmModel = createLlmModel(
              model as ModelDefinition,
              apiKey || "",
              _ollama_unused,
              _litellm_unused,
            );
            await createStreamingResponse(
              llmModel,
              toolsets as ToolSet,
              messages,
              streamingContext,
              provider,
              toolsets,
              temperature,
              systemPrompt,
            );
          }
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

    try {
      mcpClientManager.clearElicitationCallback();
    } catch (cleanupError) {
      console.error("[mcp/chat] Error during cleanup:", cleanupError);
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

export default chat;
