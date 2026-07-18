import type { ModelMessage, Tool as AiTool, ToolChoice, ToolSet } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  appendToolCallsForPrompt,
  extractFinalAssistantMessage,
  extractToolErrors,
  type ToolCall,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import { isPinnedTurn, type PromptTurn } from "@/shared/steps";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { EvalToolChoice } from "@/shared/tool-choice";
import { logger } from "../../utils/logger.js";
import {
  runDirectChatTurn,
  type RunDirectChatTurnHandle,
} from "../../utils/direct-chat-turn.js";
import type { createLlmModel } from "../../utils/chat-helpers.js";
import type { PrepareChatV2Result } from "../../utils/chat-v2-orchestration.js";
import { buildPinnedTurnAccounting, runPinnedTurn } from "./pinned-turn.js";
import type { PinnedTurnSsePayload } from "./pinned-turn-sse.js";
import { EVAL_WIDGET_MODEL_CONTEXT } from "../../config.js";
import { withWidgetContextSystemPrompt } from "./widget-interaction-context.js";
import {
  createAiSdkEvalTraceContext,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
} from "./eval-trace-capture.js";
import { consumeFullStreamAsEvalEvents } from "./stream-adapter.js";
import type { BrowserSessionContext } from "../browser-session-context.js";
import type { UsageTotals } from "./types.js";
import type { LiveChatTraceUsage } from "@/shared/live-chat-trace";

export type LocalEvalTurnAcc = {
  conversationMessages: ModelMessage[];
  capturedSpans: EvalTraceSpan[];
  accumulatedUsage: UsageTotals;
  toolsCalledByPrompt: ToolCall[][];
  assistantMessageByPrompt: (string | undefined)[];
  toolErrorsByPrompt: ToolErrorRecord[][];
  pinnedToolErrors: ToolErrorRecord[];
  activePromptIndex: number;
  activePromptInputMessages: ModelMessage[];
  activePartialResponseMessages: ModelMessage[];
  activeCompletedStepCount: number;
  activeTraceCtx: ReturnType<typeof createAiSdkEvalTraceContext> | null;
  iterationError: string | undefined;
  iterationErrorDetails: string | undefined;
  pinnedSetupFailure: boolean;
};

export type LocalEvalTurnOutcome =
  | { kind: "completed" }
  | { kind: "cancelled" };

export type LocalEvalTurnSinks = {
  emit?: Parameters<typeof consumeFullStreamAsEvalEvents>[1]["emit"];
  getStepIndex?: () => number;
  // PR2 — streaming SSE hooks. No-op on the batch path (which passes none), so
  // batch persisted output is unchanged. The streaming runner builds the rich
  // SSE events (turn_start / step_finish + failure + turn_finish trace_snapshots
  // / step_status) from these; `usage` in `onStepSnapshot` is this turn's
  // running total (baseline + turnUsage), matching the old streaming runner's
  // mid-run snapshots, and is computed without mutating `acc.accumulatedUsage`.
  /** After the user prompt is appended, before the engine call. */
  onTurnStart?: () => void;
  /** Per completed step (for a `step_finish` trace_snapshot). */
  onStepSnapshot?: (ctx: {
    stepIndex: number;
    messages: ModelMessage[];
    spans: EvalTraceSpan[];
    usage: UsageTotals;
  }) => void;
  /** A turn failed (no content / non-tool step error). */
  onTurnFailure?: (ctx: {
    messages: ModelMessage[];
    spans: EvalTraceSpan[];
    usage: UsageTotals;
    stepIndex?: number;
    iterationError: string;
  }) => void;
  /** A turn fully succeeded. */
  onTurnSuccess?: (ctx: {
    messages: ModelMessage[];
    spans: EvalTraceSpan[];
    usage: UsageTotals;
  }) => void;
  /**
   * PR5 — a model-free pinned (`toolCall`) turn ran. There is no model stream
   * to translate, so the streaming runner synthesizes the SSE sequence from
   * this (via `emitPinnedTurnSse`). `messages` is the persisted shape (user
   * "Pinned tool call …" + assistant summary) so the live trace matches the
   * finalized iteration. `iterationError` set ⇒ the pinned call failed before
   * an MCP call ran (server not connected, etc.). Typed as the shared SSE
   * payload (minus the runner-owned `turnIndex`) so the sink and the emitter
   * cannot drift.
   */
  onPinnedTurn?: (ctx: Omit<PinnedTurnSsePayload, "turnIndex">) => void;
};

export type DriveLocalEvalTurnParams = {
  promptIndex: number;
  promptTurn: PromptTurn;
  acc: LocalEvalTurnAcc;
  browser: BrowserSessionContext;
  mcpClientManager: MCPClientManager;
  selectedServers: string[];
  resolvePinnedServerKey: (
    pinned: NonNullable<PromptTurn["pinnedToolCall"]>
  ) => string | undefined;
  prepared: PrepareChatV2Result | null;
  llmModel: ReturnType<typeof createLlmModel> | null;
  test: {
    model: string;
    provider: string;
  };
  runStartedAt: number;
  runIndex: number;
  iterationId: string | undefined;
  suiteId: string | undefined;
  runId: string | null;
  testCaseId: string | undefined;
  abortSignal: AbortSignal | undefined;
  toolChoice: EvalToolChoice | undefined;
  extractToolCalls: (params: {
    steps?: ReadonlyArray<any>;
    messages: ModelMessage[];
  }) => ToolCall[];
  sinks?: LocalEvalTurnSinks;
};

/**
 * Cache-token fields for a mid-run snapshot usage object: baseline (iteration
 * cumulative as of turn start) + this turn's cumulative `turnUsage`, only
 * emitting a key when its total is positive so cache-free evals keep the
 * plain 3-field usage shape.
 */
function cacheUsageFields(
  baseline: { cachedInputTokens: number; cacheWriteTokens: number; noCacheInputTokens: number },
  turnUsage: LiveChatTraceUsage | undefined,
): Partial<UsageTotals> {
  const out: Partial<UsageTotals> = {};
  const read = baseline.cachedInputTokens + (turnUsage?.cachedInputTokens ?? 0);
  if (read > 0) out.cachedInputTokens = read;
  const write = baseline.cacheWriteTokens + (turnUsage?.cacheWriteTokens ?? 0);
  if (write > 0) out.cacheWriteTokens = write;
  const noCache =
    baseline.noCacheInputTokens + (turnUsage?.noCacheInputTokens ?? 0);
  if (noCache > 0) out.noCacheInputTokens = noCache;
  return out;
}

async function consumeDirectChatTurnViaFullStream(
  handle: RunDirectChatTurnHandle,
  sinks: LocalEvalTurnSinks | undefined
) {
  try {
    const maybeFullStream = handle.result.fullStream;
    if (
      maybeFullStream &&
      typeof maybeFullStream === "object" &&
      Symbol.asyncIterator in maybeFullStream
    ) {
      await consumeFullStreamAsEvalEvents(maybeFullStream, {
        emit: sinks?.emit ?? (() => {}),
        getStepIndex: sinks?.getStepIndex ?? (() => 0),
      });
    } else {
      await handle.result.consumeStream();
    }
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

export async function driveLocalEvalTurn(
  params: DriveLocalEvalTurnParams
): Promise<LocalEvalTurnOutcome> {
  const {
    promptIndex,
    promptTurn,
    acc,
    browser,
    mcpClientManager,
    prepared,
    llmModel,
    test,
    runStartedAt,
    runIndex,
    iterationId,
    suiteId,
    runId,
    testCaseId,
    abortSignal,
    toolChoice,
    sinks,
  } = params;

  const localIsAborted = () => abortSignal?.aborted === true;
  if (localIsAborted()) return { kind: "cancelled" };

  acc.activePromptIndex = promptIndex;
  browser.setActivePromptIndex(promptIndex);
  browser.setActiveWidgetChecks(promptTurn.widgetChecks ?? []);

  if (isPinnedTurn(promptTurn) && promptTurn.pinnedToolCall) {
    await browser.dismissCarriedWidget();
    const pinned = promptTurn.pinnedToolCall;
    const serverKey = params.resolvePinnedServerKey(pinned);
    const pinnedResult = await runPinnedTurn({
      pinned,
      resolvedServerKey: serverKey,
      mcpClientManager,
      browser,
      promptIndex,
    });
    const accounting = buildPinnedTurnAccounting(pinned, pinnedResult);
    acc.conversationMessages.push(
      accounting.userMessage,
      accounting.assistantMessage
    );
    appendToolCallsForPrompt(
      acc.toolsCalledByPrompt,
      promptIndex,
      accounting.toolCalls
    );
    acc.assistantMessageByPrompt[promptIndex] = accounting.summary;
    acc.toolErrorsByPrompt[promptIndex] = accounting.toolErrors;
    acc.pinnedToolErrors.push(...accounting.toolErrors);
    if (accounting.iterationError && !acc.iterationError) {
      acc.iterationError = accounting.iterationError;
      acc.pinnedSetupFailure = true;
    }
    sinks?.onPinnedTurn?.({
      prompt: accounting.prompt,
      messages: acc.conversationMessages,
      spans: acc.capturedSpans,
      usage: acc.accumulatedUsage,
      ...(pinnedResult.toolCall ? { toolCall: pinnedResult.toolCall } : {}),
      ...(pinnedResult.toolCallId
        ? { toolCallId: pinnedResult.toolCallId }
        : {}),
      ...("toolResult" in pinnedResult
        ? { toolResult: pinnedResult.toolResult }
        : {}),
      ...(pinnedResult.toolResultIsError
        ? { toolResultIsError: pinnedResult.toolResultIsError }
        : {}),
      ...(pinnedResult.toolError ? { toolError: pinnedResult.toolError } : {}),
      ...(pinnedResult.iterationError
        ? { iterationError: pinnedResult.iterationError }
        : {}),
    });
    return { kind: "completed" };
  }

  if (!llmModel || !prepared) {
    throw new Error(
      "eval: model-driven turn reached without model setup (caseNeedsModel invariant violated)"
    );
  }

  await browser.dismissCarriedWidget();
  acc.conversationMessages.push({ role: "user", content: promptTurn.prompt });
  acc.activePromptInputMessages = [...acc.conversationMessages];
  acc.activePartialResponseMessages = [];
  acc.activeCompletedStepCount = 0;
  // Snapshot the iteration-cumulative usage at turn start so streaming mid-run
  // snapshots can show this turn's running total without mutating
  // `acc.accumulatedUsage` (which the batch path reconciles post-consume).
  const accumulatedUsageBeforeTurn = {
    inputTokens: acc.accumulatedUsage.inputTokens ?? 0,
    outputTokens: acc.accumulatedUsage.outputTokens ?? 0,
    totalTokens: acc.accumulatedUsage.totalTokens ?? 0,
    cachedInputTokens: acc.accumulatedUsage.cachedInputTokens ?? 0,
    cacheWriteTokens: acc.accumulatedUsage.cacheWriteTokens ?? 0,
    noCacheInputTokens: acc.accumulatedUsage.noCacheInputTokens ?? 0,
  };
  sinks?.onTurnStart?.();

  const promptInputLength = acc.activePromptInputMessages.length;
  const handle = runDirectChatTurn({
    llmModel,
    modelId: test.model,
    messageHistory: acc.activePromptInputMessages,
    traceStartedAt: runStartedAt,
    // PR2 (flagged): append recorded model-visible widget interactions as a
    // per-turn system-prompt addendum so the model reasons over them — reusing
    // the same server-side mechanism Playground uses for ui/update-model-context
    // (system prompt only: no transcript/matcher/persistence impact).
    systemPrompt: EVAL_WIDGET_MODEL_CONTEXT
      ? withWidgetContextSystemPrompt(
          prepared.enhancedSystemPrompt ?? "",
          browser.browserInteractionSteps
        )
      : prepared.enhancedSystemPrompt ?? "",
    ...(prepared.resolvedTemperature == null
      ? {}
      : { temperature: prepared.resolvedTemperature }),
    tools: { ...prepared.allTools, ...browser.computerWidgetTools } as ToolSet,
    progressivePlan: prepared.progressivePlan,
    discoveryState: prepared.discoveryState,
    ...(browser.prepareAdvertisedTools
      ? { prepareAdvertisedTools: browser.prepareAdvertisedTools }
      : {}),
    ...(abortSignal ? { abortSignal } : {}),
    ...(toolChoice
      ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
      : {}),
    experimentalTelemetry: {
      isEnabled: true,
      functionId: "evals.streamText",
      recordInputs: false,
      recordOutputs: false,
      metadata: {
        source: "evals",
        ...(suiteId ? { suiteId } : {}),
        ...(runId ? { runId } : {}),
        ...(testCaseId ? { testCaseId } : {}),
        ...(iterationId ? { iterationId } : {}),
        iterationNumber: runIndex + 1,
        provider: test.provider,
        model: test.model,
        promptIndex,
      },
    },
    traceEvents: {
      onStepSnapshot: ({ traceHistory, traceTurn }) => {
        acc.activeCompletedStepCount += 1;
        acc.activePartialResponseMessages = traceHistory.slice(
          promptInputLength
        ) as ModelMessage[];
        sinks?.onStepSnapshot?.({
          stepIndex: acc.activeCompletedStepCount - 1,
          messages: [
            ...acc.activePromptInputMessages,
            ...acc.activePartialResponseMessages,
          ],
          spans: [...acc.capturedSpans, ...traceTurn.turnSpans],
          usage: {
            inputTokens:
              accumulatedUsageBeforeTurn.inputTokens +
              (traceTurn.turnUsage?.inputTokens ?? 0),
            outputTokens:
              accumulatedUsageBeforeTurn.outputTokens +
              (traceTurn.turnUsage?.outputTokens ?? 0),
            totalTokens:
              accumulatedUsageBeforeTurn.totalTokens +
              (traceTurn.turnUsage?.totalTokens ?? 0),
            ...cacheUsageFields(
              accumulatedUsageBeforeTurn,
              traceTurn.turnUsage,
            ),
          },
        });
      },
      onToolResultChunk: (chunk) => browser.handleDirectToolResultChunk(chunk),
    },
  });
  acc.activeTraceCtx = handle.traceContext;

  const headless = await consumeDirectChatTurnViaFullStream(handle, sinks);

  if (headless.aborted || localIsAborted()) {
    logger.debug(
      "[evals] local-BYOK iteration aborted mid-turn; skipping record"
    );
    return { kind: "cancelled" };
  }

  const promptResponseMessages =
    headless.messages.length > 0
      ? headless.messages
      : acc.activePartialResponseMessages;

  if (acc.activeTraceCtx.recordedSpans.length > 0) {
    patchAiSdkRecordedSpansMessageRangesFromSteps(
      acc.activeTraceCtx.recordedSpans,
      acc.activePromptInputMessages.length,
      headless.steps,
      promptIndex
    );
  }

  acc.accumulatedUsage.inputTokens =
    (acc.accumulatedUsage.inputTokens ?? 0) +
    (headless.totalUsage?.inputTokens ?? 0);
  acc.accumulatedUsage.outputTokens =
    (acc.accumulatedUsage.outputTokens ?? 0) +
    (headless.totalUsage?.outputTokens ?? 0);
  acc.accumulatedUsage.totalTokens =
    (acc.accumulatedUsage.totalTokens ?? 0) +
    (headless.totalUsage?.totalTokens ?? 0);
  // AI SDK totalUsage exposes cache tokens on `inputTokenDetails` (with the
  // deprecated flat `cachedInputTokens` alias for reads). Accumulate onto the
  // iteration usage, only setting a field when the running total is positive.
  const td = headless.totalUsage?.inputTokenDetails;
  const cacheRead =
    (acc.accumulatedUsage.cachedInputTokens ?? 0) +
    (td?.cacheReadTokens ?? headless.totalUsage?.cachedInputTokens ?? 0);
  if (cacheRead > 0) acc.accumulatedUsage.cachedInputTokens = cacheRead;
  const cacheWrite =
    (acc.accumulatedUsage.cacheWriteTokens ?? 0) + (td?.cacheWriteTokens ?? 0);
  if (cacheWrite > 0) acc.accumulatedUsage.cacheWriteTokens = cacheWrite;
  const noCache =
    (acc.accumulatedUsage.noCacheInputTokens ?? 0) + (td?.noCacheTokens ?? 0);
  if (noCache > 0) acc.accumulatedUsage.noCacheInputTokens = noCache;

  if (promptResponseMessages.length === 0) {
    acc.iterationError =
      "Stream returned no content (local-BYOK driver failed)";
    logger.error(
      "[evals] streamText returned no new messages this turn; treating as cycle failure"
    );
    acc.capturedSpans.push(...acc.activeTraceCtx.recordedSpans);
    appendToolCallsForPrompt(acc.toolsCalledByPrompt, promptIndex, []);
    acc.assistantMessageByPrompt[promptIndex] = extractFinalAssistantMessage(
      promptResponseMessages
    );
    acc.toolErrorsByPrompt[promptIndex] = extractToolErrors({
      spans: acc.activeTraceCtx.recordedSpans,
      messages: promptResponseMessages as Array<{
        role: string;
        content: unknown;
      }>,
    });
    sinks?.onTurnFailure?.({
      messages: acc.activePromptInputMessages,
      spans: acc.capturedSpans,
      usage: acc.accumulatedUsage,
      ...(acc.activeCompletedStepCount > 0
        ? { stepIndex: acc.activeCompletedStepCount - 1 }
        : {}),
      iterationError: acc.iterationError ?? "",
    });
    return { kind: "completed" };
  }

  const stepErrorSpan = acc.activeTraceCtx.recordedSpans.find(
    (span) =>
      span.status === "error" &&
      span.category !== "tool" &&
      !(span as { toolCallId?: string }).toolCallId
  );
  if (stepErrorSpan) {
    acc.iterationError = `Local-BYOK step failed mid-turn: ${stepErrorSpan.name}`;
    logger.error(
      `[evals] streamText recorded non-tool error span; treating as cycle failure (span=${stepErrorSpan.name} category=${stepErrorSpan.category})`
    );
    acc.capturedSpans.push(...acc.activeTraceCtx.recordedSpans);
    appendToolCallsForPrompt(
      acc.toolsCalledByPrompt,
      promptIndex,
      params.extractToolCalls({
        steps: headless.steps,
        messages: promptResponseMessages,
      })
    );
    acc.assistantMessageByPrompt[promptIndex] = extractFinalAssistantMessage(
      promptResponseMessages
    );
    acc.toolErrorsByPrompt[promptIndex] = extractToolErrors({
      spans: acc.activeTraceCtx.recordedSpans,
      messages: promptResponseMessages as Array<{
        role: string;
        content: unknown;
      }>,
    });
    acc.conversationMessages = [
      ...acc.activePromptInputMessages,
      ...promptResponseMessages,
    ];
    sinks?.onTurnFailure?.({
      messages: acc.conversationMessages,
      spans: acc.capturedSpans,
      usage: acc.accumulatedUsage,
      ...(acc.activeCompletedStepCount > 0
        ? { stepIndex: acc.activeCompletedStepCount - 1 }
        : {}),
      iterationError: acc.iterationError ?? "",
    });
    return { kind: "completed" };
  }

  const promptToolsCalled = params.extractToolCalls({
    steps: headless.steps,
    messages: promptResponseMessages,
  });
  appendToolCallsForPrompt(
    acc.toolsCalledByPrompt,
    promptIndex,
    promptToolsCalled
  );
  acc.assistantMessageByPrompt[promptIndex] = extractFinalAssistantMessage(
    promptResponseMessages
  );
  acc.toolErrorsByPrompt[promptIndex] = extractToolErrors({
    spans: acc.activeTraceCtx.recordedSpans,
    messages: promptResponseMessages as Array<{
      role: string;
      content: unknown;
    }>,
  });
  acc.capturedSpans.push(...acc.activeTraceCtx.recordedSpans);
  acc.conversationMessages = [
    ...acc.activePromptInputMessages,
    ...promptResponseMessages,
  ];
  sinks?.onTurnSuccess?.({
    messages: acc.conversationMessages,
    spans: acc.capturedSpans,
    usage: acc.accumulatedUsage,
  });

  acc.activeTraceCtx = null;
  acc.activePromptInputMessages = [];
  acc.activePartialResponseMessages = [];
  acc.activeCompletedStepCount = 0;

  return { kind: "completed" };
}
