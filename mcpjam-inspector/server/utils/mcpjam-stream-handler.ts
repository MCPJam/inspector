/**
 * MCPJam Stream Handler
 *
 * Handles the agentic loop for MCPJam-provided models.
 * The LLM lives in Convex (to protect the OpenRouter key),
 * while MCP tools execute locally in this Express server.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  parseJsonEventStream,
  uiMessageChunkSchema,
  type ToolSet,
} from "ai";
import type {
  UIMessageChunk,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "@/shared/http-tool-calls";
import {
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
} from "./chat-helpers";
import {
  serializeToolsForConvex,
  type ToolDefinition,
} from "./mcpjam-tool-helpers";
import { logger } from "./logger";

const MAX_STEPS = 20;

export interface MCPJamHandlerOptions {
  messages: ModelMessage[];
  modelId: string;
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  authHeader?: string;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
}

interface StepContext {
  writer: {
    write: (chunk: UIMessageChunk) => void;
  };
  messageHistory: ModelMessage[];
  toolDefs: ToolDefinition[];
  tools: ToolSet;
  authHeader?: string;
  modelId: string;
  systemPrompt: string;
  temperature?: number;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
}

interface StreamResult {
  contentParts: Array<TextPart | ToolCallPart>;
  hasToolCalls: boolean;
  finishChunk: UIMessageChunk | null;
}

/**
 * Generate a unique tool call ID
 */
function generateToolCallId(): string {
  return `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Scrub messages for sending to the backend LLM.
 * Removes UI-specific metadata that shouldn't be sent to the model.
 */
function scrubMessagesForBackend(
  messages: ModelMessage[],
  mcpClientManager: MCPClientManager,
  selectedServers?: string[],
): ModelMessage[] {
  return scrubChatGPTAppsToolResultsForBackend(
    scrubMcpAppsToolResultsForBackend(
      messages,
      mcpClientManager,
      selectedServers,
    ),
    mcpClientManager,
    selectedServers,
  );
}

/**
 * Process the SSE stream from Convex and extract content parts.
 * Forwards relevant chunks to the client while building up the message content.
 */
async function processStream(
  body: ReadableStream<Uint8Array>,
  writer: StepContext["writer"],
): Promise<StreamResult> {
  const contentParts: Array<TextPart | ToolCallPart> = [];
  let pendingText = "";
  let hasToolCalls = false;
  let finishChunk: UIMessageChunk | null = null;

  const flushText = () => {
    if (pendingText) {
      contentParts.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  const parsedStream = parseJsonEventStream({
    stream: body,
    schema: uiMessageChunkSchema,
  });
  const reader = parsedStream.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (!value?.success) {
        writer.write({
          type: "error",
          errorText: value?.error?.message ?? "stream parse failed",
        });
        break;
      }

      const chunk = value.value;

      // Skip backend stub tool outputs - we execute tools locally
      if (
        chunk?.type === "tool-output-available" ||
        chunk?.type === "tool-output-error"
      ) {
        continue;
      }

      // Handle chunk by type
      switch (chunk?.type) {
        case "text-start":
          flushText();
          writer.write(chunk);
          break;

        case "text-delta":
          pendingText += chunk.delta ?? "";
          writer.write(chunk);
          break;

        case "text-end":
          flushText();
          writer.write(chunk);
          break;

        case "tool-input-available":
          flushText();
          contentParts.push({
            type: "tool-call",
            toolCallId: chunk.toolCallId ?? generateToolCallId(),
            toolName: chunk.toolName,
            input: chunk.input ?? {},
          });
          hasToolCalls = true;
          writer.write(chunk);
          break;

        case "finish":
          finishChunk = chunk;
          // Don't write finish yet - wait until we know we're done
          break;

        default:
          // Forward other chunks (step-start, etc.)
          writer.write(chunk);
      }
    }
  } finally {
    reader.releaseLock();
  }

  flushText();
  return { contentParts, hasToolCalls, finishChunk };
}

/**
 * Emit tool results to the client stream.
 * Called after tools have been executed locally.
 */
function emitToolResults(
  writer: StepContext["writer"],
  newMessages: ModelMessage[],
) {
  for (const msg of newMessages) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part?.type === "tool-result") {
          const resultPart = part as any;
          writer.write({
            type: "tool-output-available",
            toolCallId: resultPart.toolCallId,
            // Prefer full result (with _meta/structuredContent) for UI
            output: resultPart.result ?? resultPart.output,
          });
        }
      }
    }
  }
}

/**
 * Emit tool-input-available events for inherited unresolved tool calls.
 * These are tool calls from previous messages that haven't been executed yet.
 */
function emitInheritedToolCalls(
  writer: StepContext["writer"],
  messageHistory: ModelMessage[],
  beforeStepLength: number,
) {
  // Collect existing tool result IDs
  const existingResultIds = new Set<string>();
  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part?.type === "tool-result") {
          existingResultIds.add((part as any).toolCallId);
        }
      }
    }
  }

  // Emit for inherited tool calls (before this step) that don't have results
  for (let i = 0; i < beforeStepLength; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant" && Array.isArray((msg as any).content)) {
      for (const part of (msg as any).content) {
        if (
          typeof part !== "string" &&
          part?.type === "tool-call" &&
          !existingResultIds.has(part.toolCallId)
        ) {
          writer.write({
            type: "tool-input-available",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? {},
          });
        }
      }
    }
  }
}

/**
 * Process a single step of the agentic loop.
 * Calls Convex, streams the response, and executes tools if needed.
 */
async function processOneStep(
  ctx: StepContext,
): Promise<{ shouldContinue: boolean; didEmitFinish: boolean }> {
  const {
    writer,
    messageHistory,
    toolDefs,
    tools,
    authHeader,
    modelId,
    systemPrompt,
    temperature,
    mcpClientManager,
    selectedServers,
  } = ctx;

  const beforeStepLength = messageHistory.length;

  // Scrub messages before sending to backend
  const scrubbedMessages = scrubMessagesForBackend(
    messageHistory,
    mcpClientManager,
    selectedServers,
  );

  // Call Convex /stream endpoint
  const res = await fetch(`${process.env.CONVEX_HTTP_URL}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: JSON.stringify({
      messages: JSON.stringify(scrubbedMessages),
      model: modelId,
      systemPrompt,
      ...(temperature !== undefined ? { temperature } : {}),
      tools: toolDefs,
    }),
  });

  if (!res.ok || !res.body) {
    const errorText = await res.text().catch(() => "stream failed");
    writer.write({ type: "error", errorText });
    return { shouldContinue: false, didEmitFinish: false };
  }

  // Process the stream
  const { contentParts, finishChunk } = await processStream(res.body, writer);

  // Update message history with assistant response
  if (contentParts.length > 0) {
    messageHistory.push({
      role: "assistant",
      content: contentParts,
    } as ModelMessage);
  }

  // Check for unresolved tool calls and execute them
  if (hasUnresolvedToolCalls(messageHistory)) {
    // Emit inherited tool calls that need execution
    emitInheritedToolCalls(writer, messageHistory, beforeStepLength);

    // Execute tools locally
    const beforeExecLength = messageHistory.length;
    await executeToolCallsFromMessages(messageHistory, {
      tools: tools as Record<string, any>,
    });

    // Emit results for newly executed tools
    const newMessages = messageHistory.slice(beforeExecLength);
    emitToolResults(writer, newMessages);

    return { shouldContinue: true, didEmitFinish: false };
  }

  // No more tool calls - emit finish and stop
  const didEmitFinish = !!finishChunk;
  if (finishChunk) {
    writer.write(finishChunk);
  }

  // We're done with this conversation turn
  return { shouldContinue: false, didEmitFinish };
}

/**
 * Main handler for MCPJam-provided models.
 * Orchestrates the agentic loop between Convex (LLM) and local tool execution.
 */
export async function handleMCPJamFreeChatModel(
  options: MCPJamHandlerOptions,
): Promise<Response> {
  const {
    messages,
    modelId,
    systemPrompt,
    temperature,
    tools,
    authHeader,
    mcpClientManager,
    selectedServers,
  } = options;

  const toolDefs = serializeToolsForConvex(tools);
  const messageHistory = [...messages];
  let steps = 0;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let finishEmitted = false;

      try {
        while (steps < MAX_STEPS) {
          const { shouldContinue, didEmitFinish } = await processOneStep({
            writer,
            messageHistory,
            toolDefs,
            tools,
            authHeader,
            modelId,
            systemPrompt,
            temperature,
            mcpClientManager,
            selectedServers,
          });

          steps++;
          if (didEmitFinish) {
            finishEmitted = true;
          }

          if (!shouldContinue) {
            break;
          }
        }

        // Safety: ensure we always emit a finish event
        if (!finishEmitted) {
          writer.write({
            type: "finish",
            finishReason: steps >= MAX_STEPS ? "length" : "stop",
            totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          } as unknown as UIMessageChunk);
        }
      } catch (error) {
        logger.error("[mcpjam-stream-handler] Error in agentic loop", error);
        writer.write({
          type: "error",
          errorText: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
