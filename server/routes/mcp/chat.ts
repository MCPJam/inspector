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
import { TextEncoder } from "util";

// Types for better organization
interface StreamEvent {
  type:
    | "text"
    | "tool_call"
    | "tool_result"
    | "elicitation_request"
    | "elicitation_complete"
    | "error";
  [key: string]: any;
}

interface ToolCallInfo {
  id: number;
  name: string;
  parameters: any;
  timestamp: Date;
  status: "executing" | "completed" | "error";
}

interface ToolResultInfo {
  id: number;
  toolCallId: number;
  result?: any;
  error?: string;
  timestamp: Date;
}

interface ElicitationInfo {
  requestId: string;
  message: string;
  schema: any;
  timestamp: Date;
}

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

// Stream Manager Class
class StreamManager {
  private controller: ReadableStreamDefaultController | null = null;
  private encoder: TextEncoder;
  private toolCallCounter = 0;
  private toolCallMap = new Map<string, number>(); // Maps tool call identifiers to IDs

  constructor() {
    this.encoder = new TextEncoder();
  }

  setController(controller: ReadableStreamDefaultController) {
    this.controller = controller;
  }

  private enqueue(event: StreamEvent) {
    if (this.controller) {
      this.controller.enqueue(
        this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
      );
    }
  }

  streamText(content: string) {
    this.enqueue({ type: "text", content });
  }

  streamToolCall(
    toolCall: Omit<ToolCallInfo, "id">,
    identifier?: string,
  ): number {
    const id = ++this.toolCallCounter;
    const toolCallWithId: ToolCallInfo = { ...toolCall, id };
    this.enqueue({ type: "tool_call", toolCall: toolCallWithId });

    // Store mapping if identifier provided
    if (identifier) {
      this.toolCallMap.set(identifier, id);
    }

    return id;
  }

  streamToolResult(
    toolResult: Omit<ToolResultInfo, "id" | "toolCallId">,
    identifier?: string,
  ) {
    const toolCallId = identifier
      ? this.toolCallMap.get(identifier) || this.toolCallCounter
      : this.toolCallCounter;
    const toolResultWithIds: ToolResultInfo = {
      ...toolResult,
      id: toolCallId,
      toolCallId,
    };
    this.enqueue({ type: "tool_result", toolResult: toolResultWithIds });
  }

  streamElicitationRequest(elicitation: ElicitationInfo) {
    this.enqueue({ type: "elicitation_request", ...elicitation });
  }

  streamElicitationComplete() {
    this.enqueue({ type: "elicitation_complete" });
  }

  streamError(error: string) {
    this.enqueue({ type: "error", error });
  }

  streamDone() {
    if (this.controller) {
      this.controller.enqueue(this.encoder.encode(`data: [DONE]\n\n`));
    }
  }

  close() {
    if (this.controller) {
      this.controller.close();
    }
  }

  getCurrentToolCallId(): number {
    return this.toolCallCounter;
  }
}

// Elicitation Handler Factory
function createElicitationHandler(streamManager: StreamManager) {
  return async (elicitationRequest: any) => {
    const requestId = `elicit_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    streamManager.streamElicitationRequest({
      requestId,
      message: elicitationRequest.message,
      schema: elicitationRequest.requestedSchema,
      timestamp: new Date(),
    });

    dbg("Elicitation requested", { requestId });

    return new Promise<{
      action: "accept" | "decline" | "cancel";
      content?: { [x: string]: unknown };
      _meta?: { [x: string]: unknown };
    }>((resolve, reject) => {
      pendingElicitations.set(requestId, { resolve, reject });

      setTimeout(() => {
        if (pendingElicitations.has(requestId)) {
          pendingElicitations.delete(requestId);
          reject(new Error("Elicitation timeout"));
        }
      }, 300000); // 5 minute timeout
    });
  };
}

// MCP Client Factory
function createMCPClientInstance(serverConfigs?: Record<string, any>) {
  if (serverConfigs && Object.keys(serverConfigs).length > 0) {
    const validation = validateMultipleServerConfigs(serverConfigs);
    if (!validation.success) {
      throw new Error(
        validation.error?.message || "Server config validation failed",
      );
    }
    return createMCPClientWithMultipleConnections(validation.validConfigs!);
  } else {
    return new MCPClient({
      id: `chat-${Date.now()}`,
      servers: {},
    });
  }
}

// Agent Setup Helper
function setupAgentWithStreaming(
  client: MCPClient,
  model: any,
  systemPrompt: string,
  streamManager: StreamManager,
) {
  const agent = new Agent({
    name: "MCP Chat Agent",
    instructions:
      systemPrompt || "You are a helpful assistant with access to MCP tools.",
    model,
  });

  const stepFinishHandler = ({ toolCalls, toolResults }: any) => {
    try {
      // Only handle tool calls and results, not text
      // Text will be handled by the main streaming loop

      // Handle tool calls
      const tcList = toolCalls as any[] | undefined;
      if (tcList && Array.isArray(tcList)) {
        for (const call of tcList) {
          streamManager.streamToolCall(
            {
              name: call.name || call.toolName,
              parameters: call.params || call.args || {},
              timestamp: new Date(),
              status: "executing",
            },
            call.name || call.toolName,
          );
        }
      }

      // Handle tool results
      const trList = toolResults as any[] | undefined;
      if (trList && Array.isArray(trList)) {
        for (const result of trList) {
          streamManager.streamToolResult({
            result: result.result,
            error: (result as any).error,
            timestamp: new Date(),
          });
        }
      }
    } catch (err) {
      dbg("stepFinishHandler error", err);
    }
  };

  const finishHandler = () => {
    dbg("finishHandler called");
    // No text streaming here - handled by main loop
  };

  return { agent, stepFinishHandler, finishHandler };
}

// Main Chat Generation Handler
async function handleChatGeneration(
  client: MCPClient,
  agent: Agent,
  messages: any[],
  streamManager: StreamManager,
  stepFinishHandler: any,
  finishHandler: any,
  serverConfigs?: Record<string, any>,
) {
  const toolsets = serverConfigs ? await client.getToolsets() : undefined;

  dbg("Streaming start", {
    toolsetServers: toolsets ? Object.keys(toolsets) : [],
    messageCount: messages.length,
  });

  const stream = await agent.stream(messages, {
    maxSteps: 10,
    toolsets,
    onStepFinish: stepFinishHandler,
    onFinish: finishHandler,
  });

  let hasContent = false;
  let chunkCount = 0;
  let accumulatedText = "";

  for await (const chunk of stream.textStream) {
    if (chunk && chunk.trim()) {
      hasContent = true;
      chunkCount++;

      // Accumulate text and stream in larger chunks to reduce frequency
      accumulatedText += chunk;

      // Stream accumulated text when it reaches a reasonable size or contains sentence endings
      if (
        accumulatedText.length >= 50 ||
        /[.!?]\s/.test(accumulatedText) ||
        accumulatedText.includes("\n")
      ) {
        streamManager.streamText(accumulatedText);
        accumulatedText = "";
      }
    }
  }

  // Stream any remaining accumulated text
  if (accumulatedText.trim()) {
    streamManager.streamText(accumulatedText);
  }

  dbg("Streaming finished", { hasContent, chunkCount });

  // Fallback if no content was streamed
  if (!hasContent) {
    dbg("No content from textStream; falling back to generate()");
    try {
      const gen = await agent.generate(messages, {
        maxSteps: 10,
        toolsets,
      });
      const finalText = gen.text || "";
      if (finalText) {
        streamManager.streamText(finalText);
      } else {
        streamManager.streamText(
          "I apologize, but I couldn't generate a response. Please try again.",
        );
      }
    } catch (fallbackErr) {
      console.error("[mcp/chat] Fallback generate() error:", fallbackErr);
      streamManager.streamError(
        fallbackErr instanceof Error
          ? fallbackErr.message
          : String(fallbackErr),
      );
    }
  }

  streamManager.streamElicitationComplete();
  streamManager.streamDone();
}

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

    // Validate required parameters
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

    // Create MCP client
    try {
      client = createMCPClientInstance(serverConfigs);
      dbg("Created MCP client", {
        hasServers: Boolean(
          serverConfigs && Object.keys(serverConfigs).length > 0,
        ),
      });
    } catch (clientError) {
      dbg("MCP client creation failed", clientError);
      return c.json(
        {
          success: false,
          error:
            clientError instanceof Error
              ? clientError.message
              : "Failed to create MCP client",
        },
        500,
      );
    }

    // Initialize LLM model
    const llmModel = getLlmModel(model, apiKey, ollamaBaseUrl);
    dbg("LLM model initialized", { provider: model.provider, id: model.id });

    // Create stream manager
    const streamManager = new StreamManager();

    // Set up elicitation handler
    const elicitationHandler = createElicitationHandler(streamManager);

    // Register elicitation handler with the client for all servers
    if (client.elicitation && client.elicitation.onRequest && serverConfigs) {
      for (const serverName of Object.keys(serverConfigs)) {
        const normalizedName = serverName
          .toLowerCase()
          .replace(/[\s\-]+/g, "_")
          .replace(/[^a-z0-9_]/g, "");
        client.elicitation.onRequest(normalizedName, elicitationHandler);
        dbg("Registered elicitation handler", { serverName, normalizedName });
      }
    }

    // Set up agent and handlers
    const { agent, stepFinishHandler, finishHandler } = setupAgentWithStreaming(
      client,
      llmModel,
      systemPrompt || "You are a helpful assistant with access to MCP tools.",
      streamManager,
    );

    const formattedMessages = messages.map((msg: ChatMessage) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Create readable stream for response
    const readableStream = new ReadableStream({
      async start(controller) {
        streamManager.setController(controller);

        try {
          await handleChatGeneration(
            client!,
            agent,
            formattedMessages,
            streamManager,
            stepFinishHandler,
            finishHandler,
            serverConfigs,
          );
        } catch (error) {
          console.error("[mcp/chat] Streaming error:", error);
          streamManager.streamError(
            error instanceof Error ? error.message : "Unknown error",
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
          streamManager.close();
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

function getLlmModel(
  modelDefinition: ModelDefinition,
  apiKey: string,
  ollamaBaseUrl?: string,
) {
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
    case "deepseek":
      return createOpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" })(
        modelDefinition.id,
      );
    case "ollama":
      const baseUrl = ollamaBaseUrl || "http://localhost:11434";
      return createOllama({
        baseURL: baseUrl,
      })(modelDefinition.id, {
        simulateStreaming: true,
      });
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
}

export default chat;
