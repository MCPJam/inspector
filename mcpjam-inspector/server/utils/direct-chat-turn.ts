import {
  streamText,
  stepCountIs,
  type ToolSet,
  type ToolChoice,
  type Tool as AiTool,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { createLlmModel } from "./chat-helpers";
import {
  appendDedupedModelMessages,
  normalizeFinishReason,
} from "@/shared/eval-trace";
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
  META_TOOL_SEARCH,
  resolveActiveToolNames,
  shouldForceInitialToolSearch,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import type { PersistedTurnTrace } from "./chat-ingestion";
import { logger } from "./logger";
import {
  applyPrepareAdvertisedTools,
  gateToolsToAdvertisedSubset,
  type PrepareAdvertisedTools,
} from "./advertised-tools";

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
  /** The tool-call arguments (already normalized via `toTraceRecord`). Lets an
   *  async consumer (the eval render-check) feed the real toolInput into the
   *  widget shim, matching what post-turn snapshot capture injects. */
  input: Record<string, unknown>;
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
  onToolResultChunk?: (
    event: DirectChatTurnToolResultChunk,
  ) => void | Promise<void>;
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

/**
 * Engine consolidation parity (route 3 collapse, see
 * `~/mcpjam-docs/unification.md`): chat-v2's `runAssistantTurn` exposes
 * `onLiveTextDelta` for streaming-text consumers that need every model
 * text-delta without going through the SSE writer. Shape mirrors
 * `MCPJamHandlerOptions.onLiveTextDelta` so routes 1+2 and route 3+4
 * agree on the live-text surface.
 *
 * Held as a top-level option on `RunDirectChatTurnOptions` (sibling to
 * `onPersist`, NOT inside `traceEvents`) because it's not a trace
 * concern — it fires alongside the trace `text_delta` callback but is
 * a separate consumer surface.
 */
export type DirectChatTurnLiveTextDelta = (delta: string) => void;

/**
 * Engine consolidation parity (route 3 collapse): structured per-step
 * settle event. Shape mirrors `MCPJamStepFinishEvent` so eval and SSE
 * consumers can map it 1:1 across all four routes. Fires once per
 * `streamText` step AFTER `traceTurn.turnSpans` has been refreshed
 * with the step's accumulated spans. `settledWithError: false` for
 * `runDirectChatTurn` since the AI SDK's `streamText` routes mid-turn
 * errors through `onError` rather than completing the step — callers
 * still receive a separate `onEngineError` event for those.
 */
export interface DirectChatTurnStepFinishEvent {
  stepIndex: number;
  promptIndex: number;
  /**
   * Cumulative usage for the turn as of step completion (the engine
   * tracks per-turn aggregates, not per-step deltas). Undefined when
   * the step had no usage signal.
   */
  turnUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  settledWithError: boolean;
  /**
   * Defensive copy of `traceTurn.turnSpans` as of step settlement.
   * Callers may retain across step boundaries without racing against
   * engine mutation of `traceTurn.turnSpans` on the next step.
   */
  turnSpans: DirectChatTurnTraceTurn["turnSpans"];
}

/**
 * Engine consolidation parity (route 3 collapse): structured error
 * event mirrored from `MCPJamEngineErrorEvent`. Fires from the
 * `streamText` `onError` branch BEFORE `onTurnError` (which is
 * SSE-shaped) so `streamSink: "none"` consumers (eval) can surface
 * the actual provider/guardrail error without parsing UI chunks. Chat
 * still consumes `onTurnError` for the SSE writer; both fire.
 *
 * `runDirectChatTurn` has only one error site (the SDK's `onError`),
 * unlike `mcpjam-stream-handler` which has three (HTTP non-OK,
 * processStream catch, outer loop catch); `httpStatus` / `code` /
 * `details` are therefore always undefined here.
 */
export interface DirectChatTurnEngineErrorEvent {
  message: string;
  code?: string;
  details?: string;
  httpStatus?: number;
  rawText: string;
  promptIndex: number;
  stepIndex?: number;
}

export interface RunDirectChatTurnOptions {
  llmModel: ReturnType<typeof createLlmModel>;
  modelId: string;
  /**
   * Logical provider for span metadata (OTel `gen_ai.provider.name`, e.g.
   * "anthropic"). Threaded from the caller's model config — never derived from
   * `modelId`. Optional: when omitted, llm/step spans simply lack `provider`.
   */
  provider?: string;
  messageHistory: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  /**
   * Browser-rendered MCP App eval PR 2: per-step advertised-tool narrowing —
   * the AI-SDK-path equivalent of
   * `MCPJamHandlerOptions.prepareAdvertisedTools`. Receives the names that
   * would otherwise be advertised this step (the progressive active subset, or
   * the full tool map in non-progressive mode) and returns the subset to keep,
   * or `undefined` for no narrowing. Names outside the default set are ignored;
   * a throw is logged and falls back to the default set. The eval runner uses
   * it to hide `computer` / `finish_widget` until a widget has rendered.
   */
  prepareAdvertisedTools?: PrepareAdvertisedTools;
  abortSignal?: AbortSignal;
  /** Optional bag of trace-event callbacks. Chat passes these; eval/headless omits. */
  traceEvents?: DirectChatTurnTraceEvents;
  /**
   * Engine consolidation parity (route 3 collapse): mirror of
   * `MCPJamHandlerOptions.onLiveTextDelta`. Fires synchronously from
   * the `chunk.type === "text-delta"` branch of `onChunk` (alongside
   * the trace `onTextDelta` callback). Wrapped in try/catch so a buggy
   * consumer can't crash the turn — failures are logged via
   * `logger.warn`. Held outside `traceEvents` because it's a separate
   * consumer surface, not a trace concern.
   */
  onLiveTextDelta?: DirectChatTurnLiveTextDelta;
  /**
   * Engine consolidation parity (route 3 collapse): mirror of
   * `MCPJamHandlerOptions.onStepFinish`. Fires from `onStepFinish`
   * after `traceTurn.turnSpans` has been refreshed. Wrapped in
   * try/catch (mirrors the safe-fire pattern in `mcpjam-stream-handler`).
   */
  onStepFinish?: (event: DirectChatTurnStepFinishEvent) => void;
  /**
   * Engine consolidation parity (route 3 collapse): mirror of
   * `MCPJamHandlerOptions.onEngineError`. Fires from the `onError`
   * branch BEFORE the SSE-shaped `traceEvents.onTurnError`. Wrapped in
   * try/catch.
   */
  onEngineError?: (event: DirectChatTurnEngineErrorEvent) => void;
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
  /**
   * Optional anchor timestamp for trace span offsets. The internal
   * `createAiSdkEvalTraceContext` uses this as the `runStartedAt` ms
   * epoch when computing `createOffsetInterval(ctx.runStartedAt, ...)`
   * offsets. Default is `Date.now()` at helper construction time.
   *
   * Multi-turn eval callers MUST pass the ITERATION start time so all
   * turn spans share the same epoch — otherwise each turn's spans
   * collapse to start-at-zero and the trace UI timeline mis-renders
   * multi-turn runs as overlapping. Cursor PR 5a review fix.
   */
  traceStartedAt?: number;
  /**
   * Optional AI SDK `toolChoice`. Eval forwards `advancedConfig.toolChoice`
   * here; chat currently never sets it. Held outside `traceEvents` because
   * it's a model-call parameter, not a trace concern.
   */
  toolChoice?: ToolChoice<Record<string, AiTool>>;
  /**
   * Per-turn step ceiling. CodeRabbit PR-review fix (Major "Do not
   * silently drop maxSteps"): the route-3 collapse silently lost
   * `OrgLocalModelHandlerOptions.maxSteps` (legacy default 30,
   * caller-configurable) when it switched to this helper's hardcoded
   * `stepCountIs(20)`. Exposing the option here lets the local-org
   * BYOK wrapper restore its legacy default + caller configurability
   * without affecting other callers (route 4 + eval headless still
   * omit and get the 20 default).
   */
  maxSteps?: number;
  /**
   * Optional `experimental_telemetry` block forwarded verbatim to
   * `streamText`. Eval populates with suite/test/iteration metadata for
   * observability; chat currently omits.
   */
  experimentalTelemetry?: Parameters<typeof streamText>[0]["experimental_telemetry"];
}

export interface RunDirectChatTurnHandle {
  result: ReturnType<typeof streamText>;
  traceContext: ReturnType<typeof createAiSdkEvalTraceContext>;
  traceTurn: DirectChatTurnTraceTurn;
  /** Model id for this turn — lets headless consumers build the real turnTrace. */
  modelId: string;
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

/**
 * Engine consolidation parity (route 3 collapse): safe-fire helper for the
 * three MCPJam-parity callbacks. Mirrors `safelyEmitLiveTextDelta` /
 * `safelyEmitEngineError` in `mcpjam-stream-handler.ts` — a sync throw or
 * a rejected promise from the consumer is logged via `logger.warn` and
 * doesn't crash the turn.
 */
function safelyFireCallback<T>(
  callback: ((event: T) => void | Promise<void>) | undefined,
  event: T,
  label: string,
): void {
  if (!callback) return;
  try {
    void Promise.resolve(callback(event)).catch((error) => {
      logger.warn(`[direct-chat-turn] ${label} callback failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn(`[direct-chat-turn] ${label} callback failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    provider,
    messageHistory,
    systemPrompt,
    temperature,
    tools,
    progressivePlan,
    discoveryState,
    prepareAdvertisedTools,
    abortSignal,
    traceEvents,
    onLiveTextDelta,
    onStepFinish,
    onEngineError,
    onPersist,
    onPersistError,
    toolChoice,
    experimentalTelemetry,
    traceStartedAt,
    maxSteps,
  } = options;
  const resolvedMaxSteps =
    typeof maxSteps === "number" && Number.isFinite(maxSteps) && maxSteps > 0
      ? Math.floor(maxSteps)
      : 20;

  // Separate array for tracing — we must NOT mutate `messageHistory` because
  // `streamText` holds a reference and internally accumulates step responses.
  // Mutating it would cause duplicate items on the next API call (OpenAI
  // Responses API rejects duplicates by id).
  const traceHistory = [...messageHistory];
  const initialMessageHistoryLength = messageHistory.length;
  // Cursor PR 5a review fix: multi-turn trace anchor. Use the
  // caller-supplied anchor when present so all turn spans share one
  // epoch; default to `Date.now()` for the single-turn / chat case.
  const turnStartedAt = Date.now();
  const traceAnchor = traceStartedAt ?? turnStartedAt;
  const traceTurn: DirectChatTurnTraceTurn = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messageHistory),
    promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
    turnStartedAt,
    turnSpans: [],
    turnUsage: undefined,
  };
  const traceContext = createAiSdkEvalTraceContext(traceAnchor);
  const providerSystemPrompt = normalizeSystemPromptForProvider(systemPrompt);
  let currentStepIndex = 0;
  // Time-to-first-chunk capture (OTel gen_ai.response.time_to_first_chunk):
  // absolute Date.now() of the first streamed chunk for each step, set once in
  // `onChunk`. `onStepFinish` turns it into `ttfcMs` relative to step start.
  const stepFirstChunkAt = new Map<number, number>();
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

  // Progressive discovery narrows the cataloged MCP tools, but tools injected
  // into the map *after* the catalog was built (e.g. the eval Computer Use
  // tools) aren't part of discovery and must stay in the advertised default set
  // — otherwise the prepareAdvertisedTools hook below could never surface them
  // (it can only keep names already in the default set). This appends those
  // non-cataloged extras to a progressive active-subset list; their per-step
  // visibility stays governed by the hook (and execution by the
  // advertised-subset gate). Returns the list unchanged when there are none
  // (chat / hosted, where every tool is cataloged).
  const withInjectedTools = (activeNames: string[]): string[] => {
    if (!progressivePlan) return activeNames;
    const cataloged = new Set(
      progressivePlan.catalog.map((entry) => entry.modelName),
    );
    const seen = new Set(activeNames);
    const out = [...activeNames];
    for (const name of Object.keys(tools)) {
      if (!cataloged.has(name) && !seen.has(name)) out.push(name);
    }
    return out;
  };

  // Mirror the step-0 advertised set into the request-payload trace so it can't
  // claim tools the model won't see on the first step (parity with the hosted
  // processOneStep request_payload). Only narrows when the hook is set; chat
  // (no hook) passes the full map unchanged. This trace is turn-level, so it
  // reflects step 0; later steps' per-step narrowing isn't re-traced here.
  let requestPayloadTools: ToolSet = tools;
  if (prepareAdvertisedTools) {
    const defaultToolNames =
      progressivePlan?.enabled && discoveryState
        ? withInjectedTools(
            resolveActiveToolNames(progressivePlan, discoveryState),
          )
        : Object.keys(tools);
    const advertised = new Set(
      applyPrepareAdvertisedTools({
        defaultToolNames,
        stepIndex: 0,
        prepareAdvertisedTools,
        onWarn: (message, meta) =>
          logger.warn(`[direct-chat-turn] ${message}`, meta),
      }),
    );
    requestPayloadTools = Object.fromEntries(
      Object.entries(tools).filter(([name]) => advertised.has(name)),
    ) as ToolSet;
  }

  traceEvents?.onRequestPayload?.({
    turnId: traceTurn.turnId,
    promptIndex: traceTurn.promptIndex,
    stepIndex: 0,
    systemPrompt,
    messages: messageHistory,
    tools: requestPayloadTools,
  });

  // Progressive mode: gate execution to the active subset. `activeTools`
  // (set in `prepareStep` below) narrows what the model sees, but a
  // hallucinated/remembered call to a non-active tool would still execute
  // against the full map. Gating wraps each tool's `execute` to throw a
  // structured "not loaded" error, which the AI SDK surfaces as an error
  // tool-result the model can recover from via `load_mcp_tools`.
  //
  // The prepareAdvertisedTools hook (PR 2) is advertise = ENFORCE the same way:
  // when it narrows the advertised set, `advertisedToolNames` (updated per step
  // in prepareStep) gates execution too, so a hidden tool call (e.g. `computer`
  // before a widget renders) becomes a recoverable tool error, not a silent
  // side effect. `null` => no hook narrowing => no-op gate.
  let advertisedToolNames: Set<string> | null = null;
  const executableTools = gateToolsToAdvertisedSubset(
    gateToolsToActiveSubset(
      tracedTools as Record<string, unknown>,
      progressivePlan,
      () => discoveryState,
    ) as Record<string, unknown>,
    () => advertisedToolNames,
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
    stopWhen: stepCountIs(resolvedMaxSteps),
    ...(abortSignal ? { abortSignal } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(experimentalTelemetry
      ? { experimental_telemetry: experimentalTelemetry }
      : {}),
    prepareStep: ({ stepNumber }) => {
      currentStepIndex = stepNumber;
      registerAiSdkPrepareStep(traceContext, stepNumber, {
        modelId,
        promptIndex: traceTurn.promptIndex,
      });
      // Base advertised set: progressive discovery narrows to the active
      // subset; otherwise the model sees the full tool map.
      let activeToolNames: string[] | undefined;
      if (progressivePlan?.enabled && discoveryState) {
        commitNewlyLoaded(discoveryState);
        activeToolNames = withInjectedTools(
          resolveActiveToolNames(progressivePlan, discoveryState),
        );
      }
      // Browser-rendered MCP App eval PR 2: layer runtime-conditional
      // advertised-tool narrowing on top (e.g. hide `computer` /
      // `finish_widget` until a widget has rendered). Mirrors the
      // stream-handler hook: names outside the default set are ignored, and a
      // throw is logged + falls back to the default set.
      if (prepareAdvertisedTools) {
        activeToolNames = applyPrepareAdvertisedTools({
          defaultToolNames: activeToolNames ?? Object.keys(tools),
          stepIndex: stepNumber,
          prepareAdvertisedTools,
          onWarn: (message, meta) =>
            logger.warn(`[direct-chat-turn] ${message}`, meta),
        });
        // advertise = ENFORCE: gate execution to this step's advertised set so
        // a hidden tool call can't take effect (read by `executableTools`).
        advertisedToolNames = new Set(activeToolNames);
      }
      const stepOptions: {
        activeTools?: string[];
        toolChoice?: ToolChoice<Record<string, AiTool>>;
      } = {};
      if (activeToolNames !== undefined) {
        stepOptions.activeTools = activeToolNames;
      }
      if (
        shouldForceInitialToolSearch(
          progressivePlan,
          discoveryState,
          stepNumber,
        ) &&
        activeToolNames?.includes(META_TOOL_SEARCH)
      ) {
        stepOptions.toolChoice = {
          type: "tool",
          toolName: META_TOOL_SEARCH,
        };
      }
      return stepOptions;
    },
    onChunk: async ({ chunk }) => {
      // First streamed chunk of this step → TTFC anchor (any chunk type).
      if (!stepFirstChunkAt.has(currentStepIndex)) {
        stepFirstChunkAt.set(currentStepIndex, Date.now());
      }
      if (chunk.type === "text-delta") {
        // Parity callback fires alongside the trace surface so
        // streaming-text consumers (mirrors `onLiveTextDelta` on the
        // MCPJam handler) receive every delta without parsing trace
        // events. Safe-fired so a buggy consumer can't crash the turn.
        if (chunk.text) {
          safelyFireCallback(onLiveTextDelta, chunk.text, "onLiveTextDelta");
        }
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
        // Awaited (the callback may be async — the eval runner renders the MCP
        // App widget here so a rendered widget is mounted before the next
        // step's `prepareStep` decides whether to advertise Computer Use).
        // Existing void-returning consumers (chat trace) are unaffected.
        await traceEvents?.onToolResultChunk?.({
          turnId: traceTurn.turnId,
          promptIndex: traceTurn.promptIndex,
          stepIndex: currentStepIndex,
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          input: toTraceRecord(chunk.input),
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

      const stepStartAt = traceContext.openSteps.get(currentStepIndex)?.startAt;
      const firstChunkAt = stepFirstChunkAt.get(currentStepIndex);
      const ttfcMs =
        typeof stepStartAt === "number" && typeof firstChunkAt === "number"
          ? Math.max(0, firstChunkAt - stepStartAt)
          : undefined;
      const responseTimestamp =
        step?.response?.timestamp instanceof Date
          ? step.response.timestamp.toISOString()
          : undefined;

      emitAiSdkOnStepFinish(traceContext, Date.now(), {
        modelId,
        inputTokens: stepUsage?.inputTokens,
        outputTokens: stepUsage?.outputTokens,
        totalTokens: stepUsage?.totalTokens,
        messageStartIndex,
        messageEndIndex,
        finishReason: normalizeFinishReason(step?.finishReason),
        provider,
        responseId: step?.response?.id,
        responseTimestamp,
        ttfcMs,
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

      // Parity callback fires AFTER `traceTurn.turnSpans` is refreshed so
      // mid-turn consumers (eval `step_finish`) see the active turn's
      // engine spans. Defensive copy of the spans array — see
      // `MCPJamStepFinishEvent.turnSpans` doc for the race rationale.
      // `settledWithError: false` here because `streamText` routes
      // mid-turn errors through `onError`, not through a settled step;
      // those callers also receive `onEngineError`.
      safelyFireCallback(
        onStepFinish,
        {
          stepIndex: currentStepIndex,
          promptIndex: traceTurn.promptIndex,
          turnUsage: traceTurn.turnUsage
            ? {
                ...(traceTurn.turnUsage.inputTokens !== undefined
                  ? { inputTokens: traceTurn.turnUsage.inputTokens }
                  : {}),
                ...(traceTurn.turnUsage.outputTokens !== undefined
                  ? { outputTokens: traceTurn.turnUsage.outputTokens }
                  : {}),
                ...(traceTurn.turnUsage.totalTokens !== undefined
                  ? { totalTokens: traceTurn.turnUsage.totalTokens }
                  : {}),
              }
            : undefined,
          settledWithError: false,
          // CodeRabbit PR-review fix (Major "Deep-clone turnSpans"):
          // shallow `[...traceTurn.turnSpans]` only copies the array
          // shell — span OBJECTS are still references to entries in
          // `traceContext.recordedSpans`, and those get patched in
          // place by `patchAiSdkRecordedSpansMessageRangesFromSteps`
          // during `onFinish` (mutates `span.messageStartIndex` /
          // `.messageEndIndex`). Consumers retaining earlier
          // `onStepFinish` events would see historical spans mutate
          // underneath them, breaking the "safe to retain across step
          // boundaries" contract documented at line 217. Clone each
          // span object so retained snapshots are immutable.
          turnSpans: traceTurn.turnSpans.map((s) => ({ ...s })),
        },
        "onStepFinish",
      );
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

      // Parity callback fires BEFORE the SSE-shaped `onTurnError` so
      // `streamSink: "none"` consumers (eval) surface the actual
      // provider/guardrail error without parsing UI chunks. Mirrors
      // `safelyEmitEngineError` in `mcpjam-stream-handler.ts`.
      safelyFireCallback(
        onEngineError,
        {
          message: errorText,
          rawText: errorText,
          promptIndex: traceTurn.promptIndex,
          stepIndex: currentStepIndex,
        },
        "onEngineError",
      );

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
    modelId,
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
  /**
   * The turn's real `PersistedTurnTrace`, built from the engine's own
   * `traceTurn` accumulator + `recordedSpans` — the SAME construction the
   * streaming `onPersist` path uses (see runDirectChatTurn). Lets the unified
   * turn facade hand direct + hosted callers an identical trace shape.
   */
  turnTrace: PersistedTurnTrace;
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
    // Build the real turnTrace from the engine's own accumulator — mirrors the
    // streaming `onPersist` construction (runDirectChatTurn ~902) so headless
    // and streaming produce the identical PersistedTurnTrace.
    const turnTrace: PersistedTurnTrace = {
      turnId: handle.traceTurn.turnId,
      promptIndex: handle.traceTurn.promptIndex,
      startedAt: handle.traceTurn.turnStartedAt,
      endedAt: Date.now(),
      spans: [...handle.traceContext.recordedSpans],
      usage: handle.traceTurn.turnUsage,
      finishReason: finishReason ?? undefined,
      modelId: handle.modelId,
    };
    return {
      messages,
      steps,
      totalUsage,
      finishReason,
      spans: handle.traceContext.recordedSpans,
      turnTrace,
      aborted: handle.isAborted(),
    };
  } finally {
    handle.cleanup();
  }
}
