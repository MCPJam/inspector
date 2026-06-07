import { streamText, stepCountIs, type ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { createLlmModel } from "./chat-helpers";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import {
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../services/evals/eval-trace-capture";
import {
  generateLiveTraceTurnId,
  getPromptIndex,
  getPromptMessageStartIndex,
  readToolServerId,
  setToolSpanMessageRangesFromResults,
  toTraceRecord,
} from "./live-chat-trace-stream";
import { normalizeSystemPromptForProvider } from "./model-request-payload";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import { isAbortError } from "@/shared/abort-errors";
import {
  commitNewlyLoaded,
  gateToolsToActiveSubset,
  resolveActiveToolNames,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import type { PersistedTurnTrace } from "./chat-ingestion";

/**
 * The chat-v2 user-API-key path (`streamDirectChatWithLiveTrace`) used to
 * own the `streamText` driver inline. PR 4a (engine consolidation,
 * `~/mcpjam-docs/unification.md`) extracts the driver into this helper so
 * eval's local-BYOK suite path (PR 4b) and the stream UI variants (PR 5)
 * can share ONE configured pipeline instead of three drifting copies.
 *
 * Two terminals are first-class from day 1:
 *
 *   1. SSE (chat) — caller passes `traceEvents` callbacks that write to
 *      a `createUIMessageStream` writer, then drives the assembled
 *      `result.toUIMessageStream(...)` into the writer.
 *   2. Headless (eval, PR 4b) — caller omits `traceEvents` and calls
 *      `consumeDirectChatTurnHeadless(handle)` to drive
 *      `result.consumeStream()` + read the terminal promises.
 *
 * Trace span recording, abort signal management, progressive-discovery
 * gating, and `prepareStep`/`onStepFinish`/`onError`/`onFinish` shape
 * stay identical to chat's existing wire — this is a refactor, not a
 * behavior change.
 */

export interface DirectChatTurnTraceTurn {
  turnId: string;
  promptIndex: number;
  promptMessageStartIndex: number;
  turnStartedAt: number;
  turnSpans: Awaited<
    ReturnType<typeof createAiSdkEvalTraceContext>
  >["recordedSpans"];
  turnUsage: LiveChatTraceUsage | undefined;
}

export interface DirectChatTurnRequestPayloadInfo {
  turnId: string;
  promptIndex: number;
  stepIndex: number;
  systemPrompt: string;
  messages: ModelMessage[];
  tools: ToolSet;
}

export interface DirectChatTurnTextDelta {
  turnId: string;
  promptIndex: number;
  stepIndex: number;
  delta: string;
}

export interface DirectChatTurnToolCallChunk {
  turnId: string;
  promptIndex: number;
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  /** Already-normalized via `toTraceRecord` — safe to forward to wire events. */
  input: Record<string, unknown>;
  serverId: string | undefined;
}

export interface DirectChatTurnToolResultChunk {
  turnId: string;
  promptIndex: number;
  stepIndex: number;
  toolCallId: string;
  toolName: string;
  output: unknown;
  serverId: string | undefined;
}

export interface DirectChatTurnStepSnapshot {
  turnId: string;
  traceHistory: ModelMessage[];
  tracedTools: ToolSet;
  traceTurn: DirectChatTurnTraceTurn;
}

export interface DirectChatTurnError {
  turnId: string;
  promptIndex: number;
  stepIndex: number;
  errorText: string;
  traceTurn: DirectChatTurnTraceTurn;
  tracedTools: ToolSet;
  traceHistory: ModelMessage[];
}

export interface DirectChatTurnFinish {
  turnId: string;
  promptIndex: number;
  stepIndex: number;
  finishReason?: string;
  usage?: LiveChatTraceUsage;
  traceTurn: DirectChatTurnTraceTurn;
}

export interface DirectChatTurnStart {
  turnId: string;
  promptIndex: number;
  startedAtMs: number;
}

export interface DirectChatTurnPersistEvent {
  responseMessages: ModelMessage[];
  assistantText: string;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  turnTrace: PersistedTurnTrace;
}

export interface DirectChatTurnTraceEvents {
  /** Fired once at the start of the turn. Chat writes a `turn_start` SSE event. */
  onTurnStart?: (event: DirectChatTurnStart) => void;
  /** Fired once with the resolved request payload (system prompt, messages, tools). */
  onRequestPayload?: (event: DirectChatTurnRequestPayloadInfo) => void;
  /** Fired for every text-delta chunk. */
  onTextDelta?: (event: DirectChatTurnTextDelta) => void;
  /** Fired for every tool-call chunk. */
  onToolCallChunk?: (event: DirectChatTurnToolCallChunk) => void;
  /** Fired for every tool-result chunk. */
  onToolResultChunk?: (event: DirectChatTurnToolResultChunk) => void;
  /**
   * Fired after each step finishes — after spans have been emitted into
   * `traceContext` and `traceHistory` has been updated. Chat uses this to
   * emit a `trace_snapshot` over SSE.
   */
  onStepSnapshot?: (event: DirectChatTurnStepSnapshot) => void;
  /**
   * Fired when the engine emits an error mid-turn (excludes abort). Chat
   * uses this to emit `error` + `turn_finish` SSE events.
   */
  onTurnError?: (event: DirectChatTurnError) => void;
  /**
   * Fired when the turn completes successfully. Chat uses this to emit a
   * final `turn_finish` SSE event.
   */
  onTurnFinish?: (event: DirectChatTurnFinish) => void;
}

export interface RunDirectChatTurnOptions {
  llmModel: ReturnType<typeof createLlmModel>;
  modelId: string;
  messageHistory: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  abortSignal?: AbortSignal;
  /** Optional bag of trace-event callbacks. Chat passes these; eval/headless omits. */
  traceEvents?: DirectChatTurnTraceEvents;
  /**
   * Optional post-turn persistence callback. Fires from `onFinish` after the
   * response messages are assembled. Chat passes this to write a
   * `chatSessions` row; eval has its own writer and omits.
   */
  onPersist?: (event: DirectChatTurnPersistEvent) => Promise<void> | void;
  /**
   * Optional warning sink, called from the catch-block inside `onPersist`
   * dispatch. Defaults to no-op. Chat passes a logger.warn.
   */
  onPersistError?: (error: unknown) => void;
}

export interface RunDirectChatTurnHandle {
  result: ReturnType<typeof streamText>;
  traceContext: ReturnType<typeof createAiSdkEvalTraceContext>;
  traceTurn: DirectChatTurnTraceTurn;
  /** Removes the abort listener (idempotent). Call from a finally block. */
  cleanup: () => void;
  /** True once the abort signal has fired (mirrors chat's local flag). */
  isAborted: () => boolean;
}

function toLiveChatTraceUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): LiveChatTraceUsage | undefined {
  if (!usage) return undefined;
  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number") next.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number")
    next.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number") next.totalTokens = usage.totalTokens;
  return Object.keys(next).length > 0 ? next : undefined;
}

function collectStepToolCallIds(
  toolCalls: Array<{ toolCallId?: string } | undefined> | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(toolCalls)) return ids;
  for (const call of toolCalls) {
    if (typeof call?.toolCallId === "string" && call.toolCallId.length > 0) {
      ids.add(call.toolCallId);
    }
  }
  return ids;
}

export function runDirectChatTurn(
  options: RunDirectChatTurnOptions,
): RunDirectChatTurnHandle {
  const {
    llmModel,
    modelId,
    messageHistory,
    systemPrompt,
    temperature,
    tools,
    progressivePlan,
    discoveryState,
    abortSignal,
    traceEvents,
    onPersist,
    onPersistError,
  } = options;

  // Separate array for tracing — we must NOT mutate `messageHistory` because
  // `streamText` holds a reference and internally accumulates step responses.
  // Mutating it would cause duplicate items on the next API call (OpenAI
  // Responses API rejects duplicates by id).
  const traceHistory = [...messageHistory];
  const initialMessageHistoryLength = messageHistory.length;
  const traceTurn: DirectChatTurnTraceTurn = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messageHistory),
    promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
    turnStartedAt: Date.now(),
    turnSpans: [],
    turnUsage: undefined,
  };
  const traceContext = createAiSdkEvalTraceContext(traceTurn.turnStartedAt);
  const providerSystemPrompt = normalizeSystemPromptForProvider(systemPrompt);
  let currentStepIndex = 0;
  let turnFinished = false;
  let aborted = abortSignal?.aborted === true;
  let listenerAttached = false;
  const markAborted = () => {
    aborted = true;
  };
  if (abortSignal) {
    abortSignal.addEventListener("abort", markAborted, { once: true });
    listenerAttached = true;
  }
  const cleanup = () => {
    if (listenerAttached && abortSignal) {
      abortSignal.removeEventListener("abort", markAborted);
      listenerAttached = false;
    }
  };

  traceEvents?.onTurnStart?.({
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    startedAtMs: traceTurn.turnStartedAt,
  });

  const tracedTools = wrapToolSetForEvalTrace(
    tools as Record<string, unknown>,
    traceContext,
    traceTurn.promptIndex,
  ) as ToolSet;

  traceEvents?.onRequestPayload?.({
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    stepIndex: 0,
    systemPrompt,
    messages: messageHistory,
    tools,
  });

  // Progressive mode: gate execution to the active subset. `activeTools`
  // (set in `prepareStep` below) narrows what the model sees, but a
  // hallucinated/remembered call to a non-active tool would still execute
  // against the full map. Gating wraps each tool's `execute` to throw a
  // structured "not loaded" error, which the AI SDK surfaces as an error
  // tool-result the model can recover from via `load_mcp_tools`.
  const executableTools = gateToolsToActiveSubset(
    tracedTools as Record<string, unknown>,
    progressivePlan,
    () => discoveryState,
  ) as ToolSet;

  // Cursor PR 4a review #2 / CodeRabbit "outside-diff": the original
  // inline code at the chat-v2.ts call site caught synchronous
  // `streamText` failures and removed the abort listener. The helper
  // owns the listener now, so it must own that cleanup too — otherwise
  // a sync throw (provider config error, ToolSet shape validation, …)
  // leaks the listener and the SSE caller has no handle to call
  // `cleanup()` against.
  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
    model: llmModel,
    messages: messageHistory,
    ...(temperature !== undefined ? { temperature } : {}),
    system: providerSystemPrompt,
    tools: executableTools,
    stopWhen: stepCountIs(20),
    ...(abortSignal ? { abortSignal } : {}),
    prepareStep: ({ stepNumber }) => {
      currentStepIndex = stepNumber;
      registerAiSdkPrepareStep(traceContext, stepNumber, {
        modelId,
        promptIndex: traceTurn.promptIndex,
      });
      if (progressivePlan?.enabled && discoveryState) {
        commitNewlyLoaded(discoveryState);
        const active = resolveActiveToolNames(progressivePlan, discoveryState);
        return { activeTools: active };
      }
      return {};
    },
    onChunk: async ({ chunk }) => {
      if (chunk.type === "text-delta") {
        traceEvents?.onTextDelta?.({
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex: currentStepIndex,
          delta: chunk.text,
        });
        return;
      }
      if (chunk.type === "tool-call") {
        traceEvents?.onToolCallChunk?.({
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex: currentStepIndex,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          input: toTraceRecord(chunk.input),
          serverId: readToolServerId(tracedTools, chunk.toolName),
        });
        return;
      }
      if (chunk.type === "tool-result") {
        traceEvents?.onToolResultChunk?.({
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex: currentStepIndex,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          output: chunk.output,
          serverId: readToolServerId(tracedTools, chunk.toolName),
        });
      }
    },
    onStepFinish: async (step) => {
      const responseMessages = Array.isArray(step?.response?.messages)
        ? (step.response.messages as ModelMessage[])
        : [];
      const beforeLength = traceHistory.length;
      appendDedupedModelMessages(traceHistory, responseMessages);
      const afterLength = traceHistory.length;
      const messageStartIndex =
        afterLength > beforeLength ? beforeLength : undefined;
      const messageEndIndex =
        afterLength > beforeLength ? afterLength - 1 : undefined;
      const stepUsage = toLiveChatTraceUsage(step.usage);

      traceTurn.turnUsage = mergeLiveChatTraceUsage(
        traceTurn.turnUsage,
        stepUsage,
      );

      emitAiSdkOnStepFinish(traceContext, Date.now(), {
        modelId,
        inputTokens: stepUsage?.inputTokens,
        outputTokens: stepUsage?.outputTokens,
        totalTokens: stepUsage?.totalTokens,
        messageStartIndex,
        messageEndIndex,
      });

      setToolSpanMessageRangesFromResults(
        traceContext.recordedSpans,
        traceHistory,
        traceTurn.promptIndex,
        currentStepIndex,
        collectStepToolCallIds(step.toolCalls),
      );

      traceTurn.turnSpans = [...traceContext.recordedSpans];
      traceEvents?.onStepSnapshot?.({
        turnId: traceTurn.turnId,
        traceHistory,
        tracedTools,
        traceTurn,
      });
    },
    onError: async ({ error }) => {
      if (turnFinished) return;
      if (aborted || isAbortError(error)) {
        aborted = true;
        turnFinished = true;
        return;
      }

      const failAt = Date.now();
      finalizeAiSdkTraceOnFailure(traceContext, failAt, {
        completedStepCount: currentStepIndex,
        lastStepEndedAt: traceContext.lastStepClosedEndAt,
        modelId,
        promptIndex: traceTurn.promptIndex,
      });
      traceTurn.turnSpans = [...traceContext.recordedSpans];
      const errorText = error instanceof Error ? error.message : String(error);

      traceEvents?.onTurnError?.({
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex: currentStepIndex,
        errorText,
        traceTurn,
        tracedTools,
        traceHistory,
      });
      turnFinished = true;
    },
    onFinish: async (event) => {
      if (aborted || abortSignal?.aborted) {
        aborted = true;
        turnFinished = true;
        return;
      }

      patchAiSdkRecordedSpansMessageRangesFromSteps(
        traceContext.recordedSpans,
        initialMessageHistoryLength,
        event.steps,
        traceTurn.promptIndex,
      );
      traceTurn.turnSpans = [...traceContext.recordedSpans];
      traceTurn.turnUsage =
        toLiveChatTraceUsage(event.totalUsage) ?? traceTurn.turnUsage;

      if (!turnFinished) {
        traceEvents?.onTurnFinish?.({
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex: currentStepIndex,
          finishReason: event.finishReason,
          usage: traceTurn.turnUsage,
          traceTurn,
        });
        turnFinished = true;
      }

      if (!onPersist) return;
      const responseMessages: ModelMessage[] = [];
      for (const step of event.steps) {
        appendDedupedModelMessages(
          responseMessages,
          Array.isArray(step?.response?.messages)
            ? (step.response.messages as ModelMessage[])
            : [],
        );
      }
      try {
        await onPersist({
          responseMessages,
          assistantText: event.text,
          toolCalls: event.steps.flatMap((step) => step.toolCalls ?? []),
          toolResults: event.steps.flatMap((step) => step.toolResults ?? []),
          usage: traceTurn.turnUsage,
          finishReason: event.finishReason,
          turnTrace: {
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
            startedAt: traceTurn.turnStartedAt,
            endedAt: Date.now(),
            spans: [...traceTurn.turnSpans],
            usage: traceTurn.turnUsage,
            finishReason: event.finishReason,
            modelId,
          },
        });
      } catch (error) {
        onPersistError?.(error);
      }
    },
  });
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    result,
    traceContext,
    traceTurn,
    cleanup,
    isAborted: () => aborted || abortSignal?.aborted === true,
  };
}

export interface DirectChatTurnHeadlessResult {
  messages: ModelMessage[];
  steps: Awaited<ReturnType<typeof streamText>["steps"]>;
  totalUsage: Awaited<ReturnType<typeof streamText>["totalUsage"]>;
  finishReason: Awaited<ReturnType<typeof streamText>["finishReason"]>;
  spans: Awaited<
    ReturnType<typeof createAiSdkEvalTraceContext>
  >["recordedSpans"];
  /** True if the abort signal fired mid-turn. The caller should drop the result on true. */
  aborted: boolean;
}

/**
 * Drives a `runDirectChatTurn` handle to completion in headless mode (no SSE).
 * Used by eval's local-BYOK path (PR 4b) and the contract test. Cleans up the
 * abort listener even on error.
 */
export async function consumeDirectChatTurnHeadless(
  handle: RunDirectChatTurnHandle,
): Promise<DirectChatTurnHeadlessResult> {
  try {
    await handle.result.consumeStream();
    const response = await handle.result.response;
    const steps = await handle.result.steps;
    const totalUsage = await handle.result.totalUsage;
    const finishReason = await handle.result.finishReason;
    const messages = Array.isArray(response?.messages)
      ? (response.messages as ModelMessage[])
      : [];
    return {
      messages,
      steps,
      totalUsage,
      finishReason,
      spans: handle.traceContext.recordedSpans,
      aborted: handle.isAborted(),
    };
  } finally {
    handle.cleanup();
  }
}
