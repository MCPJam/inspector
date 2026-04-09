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
  pruneMessages,
  type ToolSet,
} from "ai";
import type {
  UIMessageChunk,
  ReasoningUIPart,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  AssistantModelMessage,
  ToolResultPart,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { zodSchema } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import { z } from "zod";
import {
  hasUnresolvedToolCalls,
  executeToolCallsFromMessages,
} from "@/shared/http-tool-calls";
import {
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
} from "./chat-helpers";
import { normalizeModelMessagesForConvex } from "./normalize-model-messages-for-convex";
import {
  serializeToolsForConvex,
  type ToolDefinition,
} from "./mcpjam-tool-helpers";
import { logger } from "./logger";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import {
  pushAiSdkTrailingErrorSpan,
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  wrapBackendToolsForTrace,
} from "../services/evals/eval-trace-capture";
import {
  emitTraceSnapshot,
  generateLiveTraceTurnId,
  getPromptIndex,
  getPromptMessageStartIndex,
  readToolServerId,
  setToolSpanMessageRangesFromResults,
  toTraceRecord,
  writeTraceEvent,
} from "./live-chat-trace-stream";

const MAX_STEPS = 20;
const streamChunkSchema = zodSchema(z.unknown());

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
  onConversationComplete?: (
    fullHistory: ModelMessage[],
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
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
  traceTurn: LiveTraceTurnContext;
}

type PersistedAssistantPart = TextPart | ToolCallPart | ReasoningUIPart;

interface LiveTraceTurnContext {
  turnId: string;
  promptIndex: number;
  promptMessageStartIndex: number;
  turnStartedAt: number;
  turnSpans: EvalTraceSpan[];
  turnUsage?: LiveChatTraceUsage;
}

interface StreamResult {
  contentParts: PersistedAssistantPart[];
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

function getLatestUserMessageIndex(messageHistory: ModelMessage[]): number {
  for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
    if (messageHistory[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function getPromptAssistantStepBaseIndex(
  messageHistory: ModelMessage[],
  promptMessageStartIndex: number,
): number {
  let assistantCount = 0;
  for (
    let index = promptMessageStartIndex;
    index < messageHistory.length;
    index += 1
  ) {
    if (messageHistory[index]?.role === "assistant") {
      assistantCount += 1;
    }
  }
  return assistantCount;
}

function readUsageFromFinishChunk(
  finishChunk: UIMessageChunk | null,
): LiveChatTraceUsage | undefined {
  if (!finishChunk || finishChunk.type !== "finish") {
    return undefined;
  }

  // The Convex /stream endpoint sends token data via `messageMetadata` on the
  // finish chunk (using toUIMessageStreamResponse's messageMetadata callback).
  // Fall back to `totalUsage` for compatibility with test mocks / future changes.
  const chunk = finishChunk as UIMessageChunk & {
    totalUsage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    messageMetadata?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  const usage = chunk.totalUsage ?? chunk.messageMetadata;
  if (!usage) {
    return undefined;
  }

  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number") {
    next.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    next.outputTokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    next.totalTokens = usage.totalTokens;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function setStepSpanMessageRanges(
  spans: EvalTraceSpan[],
  promptIndex: number,
  stepIndex: number,
  messageStartIndex: number | undefined,
  messageEndIndex: number | undefined,
): void {
  if (
    typeof messageStartIndex !== "number" ||
    typeof messageEndIndex !== "number" ||
    messageEndIndex < messageStartIndex
  ) {
    return;
  }

  for (const span of spans) {
    if (
      (span.promptIndex ?? 0) !== promptIndex ||
      span.stepIndex !== stepIndex
    ) {
      continue;
    }
    if (typeof span.messageStartIndex !== "number") {
      span.messageStartIndex = messageStartIndex;
    }
    if (typeof span.messageEndIndex !== "number") {
      span.messageEndIndex = messageEndIndex;
    }
  }
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
  const pruned = pruneMessages({
    messages,
    reasoning: "all",
  }) as unknown as ModelMessage[];

  // First strip approval-specific parts that Convex/OpenRouter doesn't understand
  const stripped: ModelMessage[] = pruned.map((msg) => {
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

  const scrubbed = scrubChatGPTAppsToolResultsForBackend(
    scrubMcpAppsToolResultsForBackend(
      stripped,
      mcpClientManager,
      selectedServers,
    ),
    mcpClientManager,
    selectedServers,
  );
  return normalizeModelMessagesForConvex(scrubbed);
}

/**
 * Process the SSE stream from Convex and extract content parts.
 * Forwards relevant chunks to the client while building up the message content.
 */
async function processStream(
  body: ReadableStream<Uint8Array>,
  writer: StepContext["writer"],
  normalizeToolCallId: (toolCallId?: string) => string,
  traceTurn: LiveTraceTurnContext,
  stepIndex: number,
  tools: ToolSet,
  requireToolApproval?: boolean,
): Promise<StreamResult> {
  const contentParts: PersistedAssistantPart[] = [];
  let pendingText = "";
  let pendingReasoning = "";
  let pendingReasoningId: string | null = null;
  let hasToolCalls = false;
  let finishChunk: UIMessageChunk | null = null;

  const flushText = () => {
    if (pendingText) {
      contentParts.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  const flushReasoning = () => {
    if (pendingReasoning) {
      contentParts.push({
        type: "reasoning",
        text: pendingReasoning,
        state: "done",
      });
      pendingReasoning = "";
    }
    pendingReasoningId = null;
  };

  const parsedStream = parseJsonEventStream({
    stream: body,
    schema: streamChunkSchema as any,
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

      const chunk = value.value as UIMessageChunk & {
        totalUsage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        [key: string]: unknown;
      };

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
          flushReasoning();
          flushText();
          writer.write(chunk);
          break;

        case "text-delta":
          flushReasoning();
          pendingText += chunk.delta ?? "";
          writer.write(chunk);
          if (chunk.delta) {
            writeTraceEvent(writer, {
              type: "text_delta",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex,
              delta: chunk.delta,
            });
          }
          break;

        case "text-end":
          flushText();
          writer.write(chunk);
          break;

        case "reasoning-start":
          flushText();
          flushReasoning();
          pendingReasoningId = chunk.id;
          writer.write(chunk);
          break;

        case "reasoning-delta":
          flushText();
          if (pendingReasoningId !== null && chunk.id !== pendingReasoningId) {
            flushReasoning();
          }
          pendingReasoningId = chunk.id;
          pendingReasoning += chunk.delta ?? "";
          writer.write(chunk);
          break;

        case "reasoning-end":
          if (pendingReasoningId !== null && chunk.id !== pendingReasoningId) {
            flushReasoning();
            pendingReasoningId = chunk.id;
          }
          flushReasoning();
          writer.write(chunk);
          break;

        case "tool-input-start":
        case "tool-input-delta":
        case "tool-input-error": {
          flushText();
          flushReasoning();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          writer.write({ ...chunk, toolCallId });
          break;
        }

        case "tool-input-available": {
          flushText();
          flushReasoning();
          const toolCallId = normalizeToolCallId(chunk.toolCallId);
          contentParts.push({
            type: "tool-call",
            toolCallId,
            toolName: chunk.toolName,
            input: chunk.input ?? {},
          });
          hasToolCalls = true;
          writer.write({ ...chunk, toolCallId });
          writeTraceEvent(writer, {
            type: "tool_call",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
            stepIndex,
            toolCallId,
            toolName: chunk.toolName,
            input: toTraceRecord(chunk.input),
            serverId: readToolServerId(tools, chunk.toolName),
          });

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
  flushReasoning();
  return { contentParts, hasToolCalls, finishChunk };
}

/**
 * Emit tool results to the client stream.
 * Called after tools have been executed locally.
 */
function emitToolResults(
  writer: StepContext["writer"],
  mcpClientManager: MCPClientManager,
  newMessages: ModelMessage[],
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
) {
  for (const msg of newMessages) {
    if (msg?.role === "tool") {
      const toolMsg = msg as ToolModelMessage;
      for (const part of toolMsg.content) {
        if (part.type === "tool-result") {
          const toolName =
            typeof (part as any).toolName === "string"
              ? ((part as any).toolName as string)
              : undefined;
          const serverId =
            typeof (part as any).serverId === "string"
              ? ((part as any).serverId as string)
              : undefined;
          const rawOutput = (part as any).result ?? part.output;

          let outputForUi = rawOutput;
          if (rawOutput && typeof rawOutput === "object") {
            const rawOutputObj = rawOutput as Record<string, unknown>;
            const existingMeta =
              rawOutputObj._meta &&
              typeof rawOutputObj._meta === "object" &&
              rawOutputObj._meta !== null
                ? (rawOutputObj._meta as Record<string, unknown>)
                : {};
            const toolMeta =
              serverId && toolName
                ? (mcpClientManager.getAllToolsMetadata(serverId)[toolName] ??
                  {})
                : {};

            // Include descriptor metadata in streamed output so shared/minimal chat
            // can render app widgets without a tools/list prefetch.
            outputForUi = {
              ...rawOutputObj,
              _meta: {
                ...toolMeta,
                ...existingMeta,
                ...(serverId ? { _serverId: serverId } : {}),
              },
            };
          }

          writer.write({
            type: "tool-output-available",
            toolCallId: part.toolCallId,
            // Prefer full result (with _meta/structuredContent) for UI
            output: outputForUi,
          });

          if (traceTurn && typeof stepIndex === "number") {
            const errorText =
              part.output?.type === "error-text" &&
              typeof part.output.value === "string"
                ? part.output.value
                : undefined;
            writeTraceEvent(writer, {
              type: "tool_result",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex,
              toolCallId: part.toolCallId,
              toolName: toolName ?? part.toolName ?? "unknown",
              output: outputForUi,
              errorText,
              serverId,
            });
          }
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
  mcpClientManager: MCPClientManager,
  traceTurn?: LiveTraceTurnContext,
  stepIndex?: number,
): Promise<boolean> {
  // Build approvalId → toolCallId map, toolCallId → toolName map,
  // and toolCallId → assistant message index map from assistant messages
  const approvalIdToToolCallId = new Map<string, string>();
  const toolCallIdToToolName = new Map<string, string>();
  const toolCallIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messageHistory.length; i++) {
    const msg = messageHistory[i];
    if (msg?.role === "assistant") {
      const assistantMsg = msg as AssistantModelMessage;
      if (!Array.isArray(assistantMsg.content)) continue;
      for (const part of assistantMsg.content) {
        if (part.type === "tool-approval-request" && part.approvalId) {
          approvalIdToToolCallId.set(part.approvalId, part.toolCallId);
        }
        if (part.type === "tool-call" && part.toolCallId) {
          toolCallIdToToolName.set(part.toolCallId, part.toolName);
          toolCallIdToAssistantIdx.set(part.toolCallId, i);
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
    // Group denied results by assistant message index
    const deniedByAssistantIdx = new Map<number, ToolResultPart[]>();

    for (const toolCallId of deniedToolCallIds) {
      if (existingResultIds.has(toolCallId)) continue;
      const toolName = toolCallIdToToolName.get(toolCallId) ?? "unknown";
      writer.write({
        type: "tool-output-denied",
        toolCallId,
      });

      if (traceTurn && typeof stepIndex === "number") {
        writeTraceEvent(writer, {
          type: "tool_result",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          toolCallId,
          toolName,
          output: {
            type: "error-text",
            value: "Tool execution denied by user.",
          },
          errorText: "Tool execution denied by user.",
        });
      }

      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId,
        toolName,
        output: {
          type: "error-text",
          value: "Tool execution denied by user.",
        },
      };

      const assistantIdx = toolCallIdToAssistantIdx.get(toolCallId);
      if (assistantIdx !== undefined) {
        if (!deniedByAssistantIdx.has(assistantIdx))
          deniedByAssistantIdx.set(assistantIdx, []);
        deniedByAssistantIdx.get(assistantIdx)!.push(part);
      }
    }

    if (deniedByAssistantIdx.size > 0) {
      // Insert right after corresponding assistant messages (reverse order to preserve indices)
      const sortedKeys = [...deniedByAssistantIdx.keys()].sort((a, b) => b - a);
      for (const idx of sortedKeys) {
        messageHistory.splice(idx + 1, 0, {
          role: "tool",
          content: deniedByAssistantIdx.get(idx)!,
        } as ModelMessage);
      }
      didHandle = true;
    }
  }

  // Execute approved tools: collect tool calls that were approved but don't have results yet.
  // NOTE: This must run AFTER denied results are spliced in above.
  // executeToolCallsFromMessages skips tool-call IDs that already have results
  // (via existingToolResultIds), so the denied results prevent double-execution.
  const needsExecution = [...approvedToolCallIds].some(
    (id) => !existingResultIds.has(id),
  );

  if (needsExecution) {
    const newMessages = await executeToolCallsFromMessages(messageHistory, {
      tools: tools as Record<string, any>,
    });

    emitToolResults(
      writer,
      mcpClientManager,
      newMessages,
      traceTurn,
      stepIndex,
    );
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
    traceTurn,
  } = ctx;

  const beforeStepLength = messageHistory.length;
  const stepStartAbs = Date.now();
  const llmStartAbs = stepStartAbs;

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
      // Persist only once at the end of the full agentic loop via
      // onConversationComplete to avoid storing partial per-step traces.
      skipChatIngestion: true,
      messages: JSON.stringify(scrubbedMessages),
      model: modelId,
      systemPrompt,
      ...(temperature !== undefined ? { temperature } : {}),
      tools: toolDefs,
    }),
  });

  if (!res.ok || !res.body) {
    const errorText = await res.text().catch(() => "stream failed");
    const failAbs = Date.now();
    const stepMessageEndIndex =
      messageHistory.length > traceTurn.promptMessageStartIndex
        ? messageHistory.length - 1
        : undefined;
    pushBackendStepLlmFailureSpans(
      traceTurn.turnSpans,
      traceTurn.turnStartedAt,
      traceTurn.promptIndex,
      stepIndex,
      stepStartAbs,
      llmStartAbs,
      failAbs,
      {
        modelId,
        messageStartIndex:
          stepMessageEndIndex != null
            ? traceTurn.promptMessageStartIndex
            : undefined,
        messageEndIndex: stepMessageEndIndex,
      },
    );
    setStepSpanMessageRanges(
      traceTurn.turnSpans,
      traceTurn.promptIndex,
      stepIndex,
      stepMessageEndIndex != null
        ? traceTurn.promptMessageStartIndex
        : undefined,
      stepMessageEndIndex,
    );
    emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
    writeTraceEvent(writer, {
      type: "error",
      turnId: traceTurn.turnId,
      promptIndex: traceTurn.promptIndex,
      stepIndex,
      errorText,
    });
    writer.write({ type: "error", errorText });
    return { shouldContinue: false, didEmitFinish: false };
  }

  // Process the stream
  const { contentParts, finishChunk } = await processStream(
    res.body,
    writer,
    normalizeToolCallId,
    traceTurn,
    stepIndex,
    tools,
    requireToolApproval,
  );
  const llmEndAbs = Date.now();
  traceTurn.turnUsage = mergeLiveChatTraceUsage(
    traceTurn.turnUsage,
    readUsageFromFinishChunk(finishChunk),
  );

  // Update message history with assistant response
  if (contentParts.length > 0) {
    messageHistory.push({
      role: "assistant",
      content: contentParts,
    } as ModelMessage);
  }

  const stepMessageEndIndex =
    messageHistory.length > traceTurn.promptMessageStartIndex
      ? messageHistory.length - 1
      : undefined;
  const stepMessageStartIndex =
    stepMessageEndIndex != null ? traceTurn.promptMessageStartIndex : undefined;
  const stepUsage = readUsageFromFinishChunk(finishChunk);

  // Check for unresolved tool calls and execute them
  if (hasUnresolvedToolCalls(messageHistory)) {
    // When approval is required, don't execute tools — pause and let the client
    // show the approval UI. The next request will carry approval responses.
    if (requireToolApproval) {
      pushBackendStepSuccessSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        undefined,
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndex,
          messageEndIndex: stepMessageEndIndex,
          status: "ok",
        },
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndex,
        stepMessageEndIndex,
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
      if (finishChunk) {
        writer.write(finishChunk);
      }
      return { shouldContinue: false, didEmitFinish: !!finishChunk };
    }

    // Emit inherited tool calls that need execution
    emitInheritedToolCalls(writer, messageHistory, beforeStepLength);

    const toolsStartAbs = Date.now();
    try {
      const tracedTools = wrapBackendToolsForTrace(
        tools as Record<string, any>,
        {
          runStartedAt: traceTurn.turnStartedAt,
          promptIndex: traceTurn.promptIndex,
          stepIndex,
          spans: traceTurn.turnSpans,
        },
      );

      // Execute tools locally
      const newMessages = await executeToolCallsFromMessages(messageHistory, {
        tools: tracedTools as Record<string, any>,
      });
      const toolsEndAbs = Date.now();

      const newToolCallIds = new Set<string>();
      for (const msg of newMessages) {
        if (msg?.role !== "tool") {
          continue;
        }
        const toolMsg = msg as ToolModelMessage;
        for (const part of toolMsg.content) {
          if (
            part.type === "tool-result" &&
            typeof part.toolCallId === "string"
          ) {
            newToolCallIds.add(part.toolCallId);
          }
        }
      }
      setToolSpanMessageRangesFromResults(
        traceTurn.turnSpans,
        messageHistory,
        traceTurn.promptIndex,
        stepIndex,
        newToolCallIds,
      );
      const stepMessageEndIndexAfterTools =
        messageHistory.length > traceTurn.promptMessageStartIndex
          ? messageHistory.length - 1
          : undefined;
      const stepMessageStartIndexAfterTools =
        stepMessageEndIndexAfterTools != null
          ? traceTurn.promptMessageStartIndex
          : undefined;

      pushBackendStepSuccessSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        {
          startAbs: toolsStartAbs,
          endAbs: toolsEndAbs,
          pushAggregateSpan: newMessages.length === 0,
        },
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndexAfterTools,
          messageEndIndex: stepMessageEndIndexAfterTools,
          status: "ok",
        },
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndexAfterTools,
        stepMessageEndIndexAfterTools,
      );

      // Emit results for newly executed tools
      emitToolResults(
        writer,
        mcpClientManager,
        newMessages,
        traceTurn,
        stepIndex,
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
    } catch (error) {
      const failAbs = Date.now();
      pushBackendStepToolFailureSpans(
        traceTurn.turnSpans,
        traceTurn.turnStartedAt,
        traceTurn.promptIndex,
        stepIndex,
        stepStartAbs,
        { startAbs: llmStartAbs, endAbs: llmEndAbs },
        toolsStartAbs,
        failAbs,
        {
          modelId,
          inputTokens: stepUsage?.inputTokens,
          outputTokens: stepUsage?.outputTokens,
          totalTokens: stepUsage?.totalTokens,
          messageStartIndex: stepMessageStartIndex,
          messageEndIndex: stepMessageEndIndex,
          pushAggregateSpan: false,
        },
      );
      setStepSpanMessageRanges(
        traceTurn.turnSpans,
        traceTurn.promptIndex,
        stepIndex,
        stepMessageStartIndex,
        stepMessageEndIndex,
      );
      emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

      const errorText = error instanceof Error ? error.message : String(error);
      writeTraceEvent(writer, {
        type: "error",
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex,
        errorText,
      });
      writer.write({ type: "error", errorText });
      return { shouldContinue: false, didEmitFinish: false };
    }

    return { shouldContinue: true, didEmitFinish: false };
  }

  pushBackendStepSuccessSpans(
    traceTurn.turnSpans,
    traceTurn.turnStartedAt,
    traceTurn.promptIndex,
    stepIndex,
    stepStartAbs,
    { startAbs: llmStartAbs, endAbs: llmEndAbs },
    undefined,
    {
      modelId,
      inputTokens: stepUsage?.inputTokens,
      outputTokens: stepUsage?.outputTokens,
      totalTokens: stepUsage?.totalTokens,
      messageStartIndex: stepMessageStartIndex,
      messageEndIndex: stepMessageEndIndex,
      status: "ok",
    },
  );
  setStepSpanMessageRanges(
    traceTurn.turnSpans,
    traceTurn.promptIndex,
    stepIndex,
    stepMessageStartIndex,
    stepMessageEndIndex,
  );
  emitTraceSnapshot(writer, messageHistory, tools, traceTurn);

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
    onConversationComplete,
    onStreamComplete,
  } = options;

  const toolDefs = serializeToolsForConvex(tools);
  const messageHistory = [...messages];
  const usedToolCallIds = collectUsedToolCallIds(messageHistory);
  const traceTurn: LiveTraceTurnContext = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messageHistory),
    promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
    turnStartedAt: Date.now(),
    turnSpans: [],
  };
  const promptStepBaseIndex = getPromptAssistantStepBaseIndex(
    messageHistory,
    traceTurn.promptMessageStartIndex,
  );
  let steps = 0;
  let runSucceeded = false;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let finishEmitted = false;

      try {
        writeTraceEvent(writer, {
          type: "turn_start",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          startedAtMs: traceTurn.turnStartedAt,
        });

        // Process any pending approval responses from a previous request
        if (requireToolApproval) {
          const handled = await handlePendingApprovals(
            writer,
            messageHistory,
            tools,
            mcpClientManager,
            traceTurn,
            promptStepBaseIndex + steps,
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
            stepIndex: promptStepBaseIndex + steps,
            usedToolCallIds,
            traceTurn,
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
          finishEmitted = true;
        }

        writeTraceEvent(writer, {
          type: "turn_finish",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          finishReason: steps >= MAX_STEPS ? "length" : "stop",
          usage: traceTurn.turnUsage,
        });

        runSucceeded = true;
      } catch (error) {
        logger.error("[mcpjam-stream-handler] Error in agentic loop", error);
        const failAbs = Date.now();
        const errorText =
          error instanceof Error ? error.message : String(error);
        pushAiSdkTrailingErrorSpan(
          traceTurn.turnSpans,
          traceTurn.turnStartedAt,
          traceTurn.turnStartedAt,
          failAbs,
          traceTurn.promptIndex,
        );
        emitTraceSnapshot(writer, messageHistory, tools, traceTurn);
        writeTraceEvent(writer, {
          type: "error",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          errorText,
        });
        writeTraceEvent(writer, {
          type: "turn_finish",
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          usage: traceTurn.turnUsage,
        });
        writer.write({
          type: "error",
          errorText,
        });
      }
    },
    onFinish: async () => {
      try {
        if (runSucceeded) {
          try {
            await onConversationComplete?.([...messageHistory]);
          } catch (persistenceError) {
            logger.error(
              "[mcpjam-stream-handler] Error while persisting conversation",
              persistenceError,
            );
          }
        }
      } finally {
        try {
          await onStreamComplete?.();
        } catch (cleanupError) {
          logger.error(
            "[mcpjam-stream-handler] Error while running stream cleanup",
            cleanupError,
          );
        }
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
