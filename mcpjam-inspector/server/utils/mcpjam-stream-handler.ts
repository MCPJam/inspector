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
  AssistantModelMessage,
  ToolResultPart,
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
  requireToolApproval?: boolean;
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
  requireToolApproval?: boolean;
  stepIndex: number;
  usedToolCallIds: Set<string>;
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

function collectUsedToolCallIds(messages: ModelMessage[]): Set<string> {
  const usedToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (
          (part.type === "tool-call" ||
            part.type === "tool-approval-request") &&
          typeof part.toolCallId === "string"
        ) {
          usedToolCallIds.add(part.toolCallId);
        }
      }
      continue;
    }

    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (
          part.type === "tool-result" &&
          typeof part.toolCallId === "string"
        ) {
          usedToolCallIds.add(part.toolCallId);
        }
      }
    }
  }

  return usedToolCallIds;
}

function generateUniqueToolCallId(
  usedToolCallIds: Set<string>,
  prefix = "tc",
): string {
  const MAX_ATTEMPTS = 100;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const nextId = `${prefix}_${generateToolCallId()}`;
    if (!usedToolCallIds.has(nextId)) {
      usedToolCallIds.add(nextId);
      return nextId;
    }
  }
  // Fallback: use a counter-based ID that is guaranteed unique
  const fallbackId = `${prefix}_fallback_${Date.now()}_${usedToolCallIds.size}`;
  usedToolCallIds.add(fallbackId);
  return fallbackId;
}

function createToolCallIdNormalizer(
  usedToolCallIds: Set<string>,
  stepIndex: number,
): (rawToolCallId?: string) => string {
  const perStepMap = new Map<string, string>();
  let collisionCounter = 0;

  return (rawToolCallId?: string): string => {
    if (!rawToolCallId) {
      return generateUniqueToolCallId(usedToolCallIds, `step${stepIndex + 1}`);
    }

    const existing = perStepMap.get(rawToolCallId);
    if (existing) return existing;

    let normalized = rawToolCallId;
    if (usedToolCallIds.has(normalized)) {
      do {
        collisionCounter += 1;
        normalized = `${rawToolCallId}__s${stepIndex + 1}_${collisionCounter}`;
      } while (usedToolCallIds.has(normalized));
    }

    perStepMap.set(rawToolCallId, normalized);
    usedToolCallIds.add(normalized);
    return normalized;
  };
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
  // First strip approval-specific parts that Convex/OpenRouter doesn't understand
  const stripped: ModelMessage[] = messages.map((msg) => {
    if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) return msg;
      const filtered = assistantMsg.content.filter(
        (part) => part.type !== "tool-approval-request",
      );
      if (filtered.length === assistantMsg.content.length) return msg;
      return { ...msg, content: filtered } as ModelMessage;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      const filtered = toolMsg.content.filter(
        (part) => part.type !== "tool-approval-response",
      );
      if (filtered.length === toolMsg.content.length) return msg;
      return { ...msg, content: filtered } as ModelMessage;
    }

    return msg;
  });

  return scrubChatGPTAppsToolResultsForBackend(
    scrubMcpAppsToolResultsForBackend(
      stripped,
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
  normalizeToolCallId: (toolCallId?: string) => string,
  requireToolApproval?: boolean,
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

        case "tool-input-start":
        case "tool-input-delta":
        case "tool-input-error": {
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          writer.write({ ...chunk, toolCallId });
          break;
        }

        case "tool-input-available": {
          flushText();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          contentParts.push({
            type: "tool-call",
            toolCallId,
            toolName: chunk.toolName,
            input: chunk.input ?? {},
          });
          hasToolCalls = true;
          writer.write({ ...chunk, toolCallId });

          if (requireToolApproval) {
            writer.write({
              type: "tool-approval-request",
              approvalId: generateToolCallId(),
              toolCallId,
            });
          }
          break;
        }

        case "start":
          // Skip Convex's start chunk — its messageId would override the
          // SDK's message identity, causing a new assistant message instead
          // of continuing the existing one.
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
        if (part.type === "tool-result") {
          writer.write({
            type: "tool-output-available",
            toolCallId: part.toolCallId,
            // Prefer full result (with _meta/structuredContent) for UI
            output: (part as any).result ?? part.output,
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
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }
  }

  // Emit for inherited tool calls (before this step) that don't have results
  for (let i = 0; i < beforeStepLength; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (
          part.type === "tool-call" &&
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
 * Handle pending tool approvals from the previous request.
 * When the client responds with approval/denial decisions, this function
 * processes them: executes approved tools and emits denied notifications.
 *
 * Returns true if approvals were found and handled (agentic loop should continue).
 */
async function handlePendingApprovals(
  writer: StepContext["writer"],
  messageHistory: ModelMessage[],
  tools: ToolSet,
): Promise<boolean> {
  // Build approvalId → toolCallId map and toolCallId → toolName map from assistant messages
  const approvalIdToToolCallId = new Map<string, string>();
  const toolCallIdToToolName = new Map<string, string>();
  for (const msg of messageHistory) {
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (part.type === "tool-approval-request" && part.approvalId) {
          approvalIdToToolCallId.set(part.approvalId, part.toolCallId);
        }
        if (part.type === "tool-call" && part.toolCallId) {
          toolCallIdToToolName.set(part.toolCallId, part.toolName);
        }
      }
    }
  }

  if (approvalIdToToolCallId.size === 0) return false;

  // Scan tool messages for approval responses
  const approvedToolCallIds = new Set<string>();
  const deniedToolCallIds = new Set<string>();

  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-approval-response" && part.approvalId) {
          const toolCallId = approvalIdToToolCallId.get(part.approvalId);
          if (!toolCallId) continue;

          if (part.approved) {
            approvedToolCallIds.add(toolCallId);
          } else {
            deniedToolCallIds.add(toolCallId);
          }
        }
      }
    }
  }

  if (approvedToolCallIds.size === 0 && deniedToolCallIds.size === 0) {
    return false;
  }

  // Collect existing tool-result IDs once to avoid re-processing approvals
  const existingResultIds = new Set<string>();
  for (const msg of messageHistory) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          existingResultIds.add(part.toolCallId);
        }
      }
    }
  }

  let didHandle = false;

  // Emit denied tool notifications to the client and add tool-result entries
  // to messageHistory so the LLM knows which tools were denied.
  // NOTE: convertToModelMessages does NOT produce tool-results for denied tools
  // because the client-side state is 'approval-responded', not 'output-denied'.
  if (deniedToolCallIds.size > 0) {
    const deniedResultParts: ToolResultPart[] = [];

    for (const toolCallId of deniedToolCallIds) {
      if (existingResultIds.has(toolCallId)) continue;
      writer.write({
        type: "tool-output-denied",
        toolCallId,
      });

      deniedResultParts.push({
        type: "tool-result",
        toolCallId,
        toolName: toolCallIdToToolName.get(toolCallId) ?? "unknown",
        output: {
          type: "error-text",
          value: "Tool execution denied by user.",
        },
      });
    }

    if (deniedResultParts.length > 0) {
      messageHistory.push({
        role: "tool",
        content: deniedResultParts,
      } as ModelMessage);
      didHandle = true;
    }
  }

  // Execute approved tools: collect tool calls that were approved but don't have results yet
  const needsExecution = [...approvedToolCallIds].some(
    (id) => !existingResultIds.has(id),
  );

  if (needsExecution) {
    const beforeExecLength = messageHistory.length;
    await executeToolCallsFromMessages(messageHistory, {
      tools: tools as Record<string, any>,
    });

    const newMessages = messageHistory.slice(beforeExecLength);
    emitToolResults(writer, newMessages);
    didHandle = true;
  }

  return didHandle;
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
    requireToolApproval,
    stepIndex,
    usedToolCallIds,
  } = ctx;

  const beforeStepLength = messageHistory.length;

  // Scrub messages before sending to backend
  const scrubbedMessages = scrubMessagesForBackend(
    messageHistory,
    mcpClientManager,
    selectedServers,
  );

  const normalizeToolCallId = createToolCallIdNormalizer(
    usedToolCallIds,
    stepIndex,
  );

  // Call Convex /stream endpoint
  const res = await fetch(`${process.env.CONVEX_HTTP_URL}/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: JSON.stringify({
      mode: "stream",
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
  const { contentParts, finishChunk } = await processStream(
    res.body,
    writer,
    normalizeToolCallId,
    requireToolApproval,
  );

  // Update message history with assistant response
  if (contentParts.length > 0) {
    messageHistory.push({
      role: "assistant",
      content: contentParts,
    } as ModelMessage);
  }

  // Check for unresolved tool calls and execute them
  if (hasUnresolvedToolCalls(messageHistory)) {
    // When approval is required, don't execute tools — pause and let the client
    // show the approval UI. The next request will carry approval responses.
    if (requireToolApproval) {
      if (finishChunk) {
        writer.write(finishChunk);
      }
      return { shouldContinue: false, didEmitFinish: !!finishChunk };
    }

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
    requireToolApproval,
  } = options;

  const toolDefs = serializeToolsForConvex(tools);
  const messageHistory = [...messages];
  const usedToolCallIds = collectUsedToolCallIds(messageHistory);
  let steps = 0;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let finishEmitted = false;

      try {
        // Process any pending approval responses from a previous request
        if (requireToolApproval) {
          const handled = await handlePendingApprovals(
            writer,
            messageHistory,
            tools,
          );
          if (handled) {
            // Approvals were processed — if there are still unresolved tool
            // calls (shouldn't happen normally), fall through to the loop.
            // Otherwise the loop will call Convex with the new tool results.
          }
        }

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
            requireToolApproval,
            stepIndex: steps,
            usedToolCallIds,
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
