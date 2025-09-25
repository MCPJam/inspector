import { Hono } from "hono";
import { streamText } from "ai";
import {
  ChatMessage,
  ModelDefinition,
  ModelProvider,
} from "../../../shared/types";
import { TextEncoder } from "util";
import { getDefaultTemperatureByProvider } from "../../../client/src/lib/chat-utils";
import { createLlmModel } from "../../utils/chat-helpers";
import { SSEvent } from "../../../shared/sse";
import { convertMastraToolsToVercelTools } from "../../../shared/tools";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "../../../shared/http-tool-calls";
import { zodToJsonSchema } from "@alcyone-labs/zod-to-json-schema";
import type { ModelMessage, Tool } from "ai";

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
  sendMessagesToBackend?: boolean;
}

// Constants
const ELICITATION_TIMEOUT = 300000; // 5 minutes
const MAX_AGENT_STEPS = 10;

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
          const currentToolCallId = ++streamingContext.toolCallId;
          streamingContext.lastEmittedToolCallId = currentToolCallId;

          if (streamingContext.controller && streamingContext.encoder) {
            sendSseEvent(
              streamingContext.controller,
              streamingContext.encoder,
              {
                type: "tool_call",
                toolCall: {
                  id: currentToolCallId,
                  name: call.name || call.toolName,
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
              : ++streamingContext.toolCallId;

          if (streamingContext.controller && streamingContext.encoder) {
            sendSseEvent(
              streamingContext.controller,
              streamingContext.encoder,
              {
                type: "tool_result",
                toolResult: {
                  id: currentToolCallId,
                  toolCallId: currentToolCallId,
                  result: result.result,
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
  vercelTools: Record<string, Tool>,
  messages: ChatMessage[],
  streamingContext: StreamingContext,
  provider: ModelProvider,
  temperature?: number,
  systemPrompt?: string,
) => {
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
  while (steps < MAX_AGENT_STEPS) {
    let accumulatedText = "";
    const iterationToolCalls: any[] = [];
    const iterationToolResults: any[] = [];

    const streamResult = await streamText({
      model,
      system:
        systemPrompt || "You are a helpful assistant with access to MCP tools.",
      temperature:
        temperature == null || undefined
          ? getDefaultTemperatureByProvider(provider)
          : temperature,
      tools: vercelTools,
      messages: messageHistory,
      onChunk: async (chunk) => {
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
            const currentToolCallId = ++streamingContext.toolCallId;
            streamingContext.lastEmittedToolCallId = currentToolCallId;
            const name =
              (chunk.chunk as any).toolName || (chunk.chunk as any).name;
            const parameters =
              (chunk.chunk as any).input ??
              (chunk.chunk as any).parameters ??
              (chunk.chunk as any).args ??
              {};
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
              streamingContext.lastEmittedToolCallId != null
                ? streamingContext.lastEmittedToolCallId
                : streamingContext.toolCallId;
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
                },
              },
            );
            break;
          }
          default:
            break;
        }
      },
    });

    await streamResult.consumeStream();

    handleAgentStepFinish(
      streamingContext,
      accumulatedText,
      iterationToolCalls,
      iterationToolResults,
      false,
    );

    const resp = await streamResult.response;
    const responseMessages = (resp?.messages || []) as ModelMessage[];
    if (responseMessages.length) {
      messageHistory.push(...responseMessages);

      // Some providers (e.g., Ollama v2) place tool outputs as ToolModelMessages
      // in the response rather than streaming a tool-result chunk.
      for (const m of responseMessages) {
        if ((m as any).role === "tool") {
          const currentToolCallId =
            streamingContext.lastEmittedToolCallId != null
              ? streamingContext.lastEmittedToolCallId
              : ++streamingContext.toolCallId;
          const value = (m as any).content;
          iterationToolResults.push({ result: value });
          sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
            type: "tool_result",
            toolResult: {
              id: currentToolCallId,
              toolCallId: currentToolCallId,
              result: value,
              timestamp: new Date().toISOString(),
            },
          });
        }
      }
    }

    steps++;
    const finishReason = await streamResult.finishReason;
    const shouldContinue =
      finishReason === "tool-calls" ||
      (accumulatedText.length === 0 && iterationToolResults.length > 0);

    if (!shouldContinue) break;
  }

  sendSseEvent(streamingContext.controller, streamingContext.encoder!, {
    type: "elicitation_complete",
  });

  sendSseEvent(
    streamingContext.controller,
    streamingContext.encoder!,
    "[DONE]",
  );
};

const sendMessagesToBackend = async (
  messages: ChatMessage[],
  streamingContext: StreamingContext,
  mcpClientManager: any,
  baseUrl: string,
  authHeader?: string,
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

  const flatTools =
    await mcpClientManager.getFlattenedToolsetsForEnabledServers();
  const toolDefs = Object.keys(flatTools).map((name) => ({
    name,
    description: (flatTools as any)[name]?.description,
    inputSchema: zodToJsonSchema((flatTools as any)[name]?.inputSchema),
  }));

  if (!baseUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  let steps = 0;
  while (steps < MAX_AGENT_STEPS) {
    const res = await fetch(`${baseUrl}/streaming`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        tools: toolDefs,
        messages: JSON.stringify(messageHistory),
      }),
    });

    let data: any = {};
    try {
      data = await res.json();
    } catch {
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false };
      }
    }

    if (data?.ok && Array.isArray(data.messages)) {
      // Append assistant messages and emit their text/tool_call events
      for (const msg of data.messages as ModelMessage[]) {
        messageHistory.push(msg);
        if (
          (msg as any).role === "assistant" &&
          Array.isArray((msg as any).content)
        ) {
          for (const c of (msg as any).content) {
            if (c?.type === "text" && typeof c.text === "string") {
              sendSseEvent(
                streamingContext.controller,
                streamingContext.encoder!,
                {
                  type: "text",
                  content: c.text,
                },
              );
            } else if (c?.type === "tool-call") {
              const currentToolCallId = ++streamingContext.toolCallId;
              streamingContext.lastEmittedToolCallId = currentToolCallId;
              sendSseEvent(
                streamingContext.controller,
                streamingContext.encoder!,
                {
                  type: "tool_call",
                  toolCall: {
                    id: currentToolCallId,
                    name: c.toolName || c.name,
                    parameters: c.input || c.parameters || c.args || {},
                    timestamp: new Date().toISOString(),
                    status: "executing",
                  },
                },
              );
            }
          }
        }
      }
    } else {
      break;
    }

    // Execute unresolved tool calls locally and emit tool_result events
    const beforeLen = messageHistory.length;
    if (hasUnresolvedToolCalls(messageHistory as any)) {
      await executeToolCallsFromMessages(messageHistory as ModelMessage[], {
        tools: flatTools as any,
      });
      const newMsgs = messageHistory.slice(beforeLen);
      for (const m of newMsgs) {
        if ((m as any).role === "tool" && Array.isArray((m as any).content)) {
          for (const tc of (m as any).content) {
            if (tc.type === "tool-result") {
              const currentToolCallId =
                streamingContext.lastEmittedToolCallId != null
                  ? streamingContext.lastEmittedToolCallId
                  : ++streamingContext.toolCallId;
              const out = tc.output;
              const value =
                out && typeof out === "object" && "value" in out
                  ? out.value
                  : out;
              sendSseEvent(
                streamingContext.controller,
                streamingContext.encoder!,
                {
                  type: "tool_result",
                  toolResult: {
                    id: currentToolCallId,
                    toolCallId: currentToolCallId,
                    result: value,
                    timestamp: new Date().toISOString(),
                  },
                },
              );
            }
          }
        }
      }
    } else {
      break;
    }

    steps++;
  }

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
      ollamaBaseUrl: _ollama_unused,
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
      provider === "meta" && requestData.sendMessagesToBackend;

    if (!sendToBackend && (!model?.id || !requestData.apiKey)) {
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
          if (sendToBackend) {
            await sendMessagesToBackend(
              messages,
              streamingContext,
              mcpClientManager,
              process.env.CONVEX_HTTP_URL!,
              authHeader,
            );
          } else {
            // Use existing streaming path with tools
            const flatTools =
              await mcpClientManager.getFlattenedToolsetsForEnabledServers();
            const vercelTools: Record<string, Tool> =
              convertMastraToolsToVercelTools(flatTools as any);

            const llmModel = createLlmModel(
              model as ModelDefinition,
              apiKey || "",
              _ollama_unused,
            );
            await createStreamingResponse(
              llmModel,
              vercelTools,
              messages,
              streamingContext,
              provider,
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
