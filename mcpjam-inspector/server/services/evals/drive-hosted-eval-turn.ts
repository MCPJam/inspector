/**
 * drive-hosted-eval-turn.ts — the shared per-turn body of the two hosted eval
 * runners (`runIterationViaBackendWithBrowser` — batch — and
 * `streamIterationViaBackendWithBrowser` — SSE).
 *
 * Both runners drive turns through `runAssistantTurn` with identical engine
 * options, browser-pipeline hooks, accumulator drains, and the three-shape
 * failure detection; the stream runner additionally wires SSE emitters into
 * the engine callbacks and emits failure/turn-finish events. This helper owns
 * the shared skeleton; the stream runner layers its SSE concerns through
 * {@link HostedEvalTurnSinks} (built per turn via a factory so the emit
 * closures can see the turn context).
 *
 * Unification notes (deliberate convergences, both directions reviewed):
 *  - `lastEngineError` preference in the failure branches (the PR
 *    5b-followup-2 guardrail-detail fix) now applies to the batch runner too —
 *    previously only the stream runner surfaced the structured 429/guardrail
 *    reason instead of the generic fallback.
 *  - The step-error-span filter excludes spans carrying a `toolCallId`
 *    (the stream runner's Cursor/Codex review fix — child error spans that
 *    `wrapToolSetForEvalTrace` emits alongside a failed tool span must flow
 *    through the `failOnToolError` gate, not force a cycle failure). The
 *    batch runner previously matched only on `category !== "tool"`.
 *  - `toolsCalledByPrompt` gets its per-turn array pushed BEFORE the engine
 *    call (the stream runner's shape, where `onToolCall` populates it live).
 *    For the batch runner this means a turn whose engine call THROWS now
 *    contributes an empty entry instead of no entry — verdict-neutral (the
 *    accompanying `iterationError` already gates the iteration).
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { ModelDefinition } from "@/shared/types";
import type { EvalToolChoice } from "@/shared/tool-choice";
import { logger } from "../../utils/logger";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import type {
  MCPJamEngineErrorEvent,
  MCPJamStepFinishEvent,
  MCPJamToolCallEvent,
  MCPJamToolResultEvent,
} from "../../utils/mcpjam-stream-handler.js";
import type { PrepareChatV2Result } from "../../utils/chat-v2-orchestration.js";
import type { BrowserSessionContext } from "../browser-session-context.js";
import {
  createAiSdkEvalTraceContext,
  wrapToolSetForEvalTrace,
} from "./eval-trace-capture";
import type { UsageTotals } from "./types";
import {
  extractFinalAssistantMessage,
  extractToolErrors,
  type ToolErrorRecord,
} from "@/shared/eval-matching";

type ToolCall = { toolName: string; arguments: Record<string, any> };

export type HostedEvalTurnOutcome =
  | { kind: "completed" }
  /** Abort fired (between callbacks or mid-engine); record nothing. */
  | { kind: "cancelled" }
  /** Turn failed; the runner records the iteration with this error. */
  | {
      kind: "failed";
      iterationError: string;
      iterationErrorDetails?: string;
    };

/** Stream-runner SSE concerns, layered over the shared skeleton per turn. */
export interface HostedEvalTurnSinks {
  /** After the user prompt is appended, before the engine call (`turn_start`). */
  onTurnStart?: () => void;
  /** Engine callback wires (SSE emitters). The helper composes them with the
   *  browser-pipeline hooks: `onToolCall` runs after the input cache write;
   *  `onToolResult` runs BEFORE the harness render (live consumers shouldn't
   *  wait on Chromium). */
  onLiveTextDelta?: (delta: string) => void;
  onToolCall?: (event: MCPJamToolCallEvent) => void;
  onToolResult?: (event: MCPJamToolResultEvent) => void | Promise<void>;
  onStepFinish?: (event: MCPJamStepFinishEvent) => void;
  /** Before a failed turn returns (failure trace_snapshot + error SSE). */
  onTurnFailure?: (failure: {
    iterationError: string;
    iterationErrorDetails?: string;
  }) => void;
  /** After a fully-successful turn (turn_finish snapshot + SSE). */
  onTurnSuccess?: () => void;
}

/** Per-turn context handed to the sink factory so SSE closures can read the
 *  turn's accumulators (the stream runner's snapshot/step-delta math). */
export interface HostedEvalTurnSinkContext {
  promptIndex: number;
  /** Iteration-cumulative usage snapshot taken at turn start. */
  baselineUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** This turn's tool-instrumentation span context (`wrapToolSetForEvalTrace`). */
  traceCtx: ReturnType<typeof createAiSdkEvalTraceContext>;
  /** The per-turn tool-call accumulator (already pushed onto
   *  `acc.toolsCalledByPrompt`); `onToolCall` sinks may populate it live. */
  promptToolsCalled: ToolCall[];
}

export interface DriveHostedEvalTurnParams {
  promptIndex: number;
  prompt: string;
  browser: BrowserSessionContext;
  prepared: PrepareChatV2Result;
  modelDefinition: ModelDefinition;
  /** Canonical model id override for the wire payload (wallet/quota keys). */
  modelId: string;
  selectedServers: string[];
  /** Host harness selector (resolvedExecution.harness). When "claude-code" the
   *  turn runs the real Claude Code runtime; absent ⇒ emulated (today's path). */
  harness?: "claude-code";
  /** Host approval intent (resolvedExecution.requireToolApproval). Forwarded to
   *  runAssistantTurn ONLY for harness turns — runHarnessTurn fail-closes on it
   *  (no interactive approval yet). The emulated eval path is unchanged (it
   *  doesn't pass requireToolApproval; it relies on approvalMode "auto-deny"). */
  requireToolApproval?: boolean;
  /** Project that owns the host's computer — required by runHarnessTurn to
   *  resolve the E2B sandbox. Forwarded (harness turns only) from the eval's
   *  resolved billing target; absent for org-level evals (no project/computer,
   *  so a harness turn there fails fast with a clear projectId error). */
  projectId?: string;
  mcpClientManager: MCPClientManager;
  evalAuthContext: { kind: "user_bearer"; token: string };
  endpointPath: string;
  extraBodyFields: Record<string, unknown> | undefined;
  toolChoice: EvalToolChoice | undefined;
  abortSignal: AbortSignal | undefined;
  maxSteps: number;
  runStartedAt: number;
  isAborted: () => boolean;
  /** `" (stream)"` on the SSE runner so log lines stay distinguishable. */
  logSuffix?: string;
  /** The runner's `extractToolCallsFromConversation`, passed in (rather than
   *  imported) to avoid a module cycle with evals-runner.ts. */
  extractToolCalls: (messages: ModelMessage[]) => ToolCall[];
  /** Shared mutable iteration state. The helper appends/rolls in place. */
  acc: {
    messageHistory: ModelMessage[];
    capturedSpans: EvalTraceSpan[];
    accumulatedUsage: UsageTotals;
    toolsCalledByPrompt: ToolCall[][];
    // Per-turn signals for per-turn checks (PromptTurn.checks), indexed by
    // promptIndex parallel to toolsCalledByPrompt. Populated on turn success;
    // a turn that fails before capture leaves its slot unset (fail-closed).
    assistantMessageByPrompt: (string | undefined)[];
    toolErrorsByPrompt: ToolErrorRecord[][];
  };
  buildSinks?: (ctx: HostedEvalTurnSinkContext) => HostedEvalTurnSinks;
}

const truncateError = (message: string): string =>
  message.length > 500 ? message.substring(0, 497) + "..." : message;

export async function driveHostedEvalTurn(
  params: DriveHostedEvalTurnParams
): Promise<HostedEvalTurnOutcome> {
  const {
    promptIndex,
    browser,
    prepared,
    acc,
    isAborted,
    abortSignal,
  } = params;
  const logSuffix = params.logSuffix ?? "";

  // Browser-rendered MCP App eval (PR 14): stamp collected artifacts with
  // this turn.
  browser.setActivePromptIndex(promptIndex);

  // Per-turn span-capture context. `wrapToolSetForEvalTrace` instruments
  // each tool's `execute` to push to `traceCtx.recordedSpans`; we drain
  // into `acc.capturedSpans` after the engine finishes. The Computer Use
  // tools ride the same wrap so `computer` / `finish_widget` executions
  // land as tool spans in the trace UI like every other local tool.
  const traceCtx = createAiSdkEvalTraceContext(params.runStartedAt);
  const tracedTools = wrapToolSetForEvalTrace(
    { ...prepared.allTools, ...browser.computerWidgetTools },
    traceCtx,
    promptIndex
  );

  // Push the user prompt into `messageHistory` BEFORE the engine call so a
  // failed turn still persists the user side of the transcript (Cursor
  // review round-2 — the transcript stays honest about WHICH turn errored).
  acc.messageHistory.push({ role: "user", content: params.prompt });
  const inputMessages: ModelMessage[] = [...acc.messageHistory];

  const baselineUsage = {
    inputTokens: acc.accumulatedUsage.inputTokens ?? 0,
    outputTokens: acc.accumulatedUsage.outputTokens ?? 0,
    totalTokens: acc.accumulatedUsage.totalTokens ?? 0,
  };

  // Per-turn tool-call accumulator, pushed up front (the stream runner's
  // `onToolCall` populates it live; the canonical post-turn reconcile below
  // replaces the contents either way).
  const promptToolsCalled: ToolCall[] = [];
  acc.toolsCalledByPrompt.push(promptToolsCalled);

  // Built inside the pre-turn try below; `{}` until then so the failure
  // mapper can always call `sinks.onTurnFailure?.()` safely.
  let sinks: HostedEvalTurnSinks = {};

  // Shared throw → outcome mapping for the pre-turn setup AND the engine
  // call. Cancellation: AbortError can surface either as a thrown exception
  // (fetch aborted mid-flight) or as the engine's internal
  // silent-cancellation path (handled by the `isAborted()` check after the
  // success path below) — check `abortSignal.aborted` to catch BOTH paths
  // consistently. Non-abort errors map to `iterationError` for the post-loop
  // verdict gate, preserving a truncated message and, when available, a
  // `responseBody` for `errorDetails`. The turn's tool-instrumentation spans
  // are drained first so the persisted iteration (and the stream sink's
  // failure snapshot, which reads the same array) keeps whatever tool
  // executions completed before the throw — aligning with the (a)/(b)/(c)
  // failure branches below (CodeRabbit, PR 2610).
  const mapThrownTurnError = (
    error: unknown,
    failedStage: string
  ): HostedEvalTurnOutcome => {
    if (
      isAborted() ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      logger.debug(
        `[evals] backend iteration${logSuffix} aborted due to cancellation`
      );
      return { kind: "cancelled" };
    }

    acc.capturedSpans.push(...traceCtx.recordedSpans);
    let iterationError: string;
    let iterationErrorDetails: string | undefined;
    if (error instanceof Error) {
      iterationError = error.message || error.toString();
      const responseBody = (error as { responseBody?: unknown }).responseBody;
      if (responseBody && typeof responseBody === "string") {
        iterationErrorDetails = responseBody;
      }
    } else if (typeof error === "string") {
      iterationError = error;
    } else {
      iterationError = String(error);
    }
    iterationError = truncateError(iterationError);
    logger.error(`[evals] ${failedStage}${logSuffix} failed`, error);
    const failure = {
      iterationError,
      ...(iterationErrorDetails ? { iterationErrorDetails } : {}),
    };
    sinks.onTurnFailure?.(failure);
    return { kind: "failed", ...failure };
  };

  // Pre-turn setup that can genuinely throw: the Chromium widget dismissal
  // (start the turn with a clean surface — a widget kept mounted by a
  // previous prompt turn must not bleed into this one, otherwise Computer
  // Use could be advertised against the prior turn's widget before this
  // turn's own MCP App tool runs), the caller-built SSE sinks, and the
  // turn-start emit. Route their failures through the same mapping as the
  // engine call so hosted callers always receive an outcome and run normal
  // iteration persistence, instead of the throw escaping to the coarse
  // iteration-abort path (CodeRabbit, PR 2610).
  try {
    await browser.dismissCarriedWidget();
    sinks =
      params.buildSinks?.({
        promptIndex,
        baselineUsage,
        traceCtx,
        promptToolsCalled,
      }) ?? {};
    sinks.onTurnStart?.();
  } catch (error) {
    return mapThrownTurnError(error, "pre-turn setup");
  }

  // PR 5b-followup-2: capture the engine's structured-error event (429
  // daily-cap, hosted-model setup errors, …). The engine writes a generic
  // `error` UI chunk to the no-op writer (`streamSink: "none"`); the callback
  // gives the parsed `{ code?, message, details? }` so failure branches can
  // surface the actual reason instead of the generic fallback.
  let lastEngineError: MCPJamEngineErrorEvent | undefined;

  // Cursor + Codex review fix: thread `toolChoice` AND `maxOutputTokens`
  // through `extraBodyFields` since the engine options don't expose them as
  // first-class fields. `maxOutputTokens: 16384` matches the legacy per-step
  // Convex body (Cursor round-2 "Dropped eval maxOutputTokens limit").
  const mergedExtraBodyFields: Record<string, unknown> = {
    maxOutputTokens: 16384,
    ...(params.extraBodyFields ?? {}),
    ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
  };

  let turnResult: Awaited<ReturnType<typeof runUnifiedAssistantTurn>>;
  try {
    turnResult = await runUnifiedAssistantTurn({
      // Hosted runtime: routing (endpoint, extra body fields, harness) is an
      // explicit part of the discriminator, not hidden behind a string.
      runtime: {
        kind: "hosted",
        endpointPath: params.endpointPath,
        extraBodyFields: mergedExtraBodyFields,
        ...(params.harness ? { harness: params.harness } : {}),
      },
      messages: inputMessages,
      // Eval's `runTestCase` already resolved the canonical model id
      // (`getCanonicalModelId(modelDefinition.id, provider)`) and threads it
      // in as `modelId`. The engine reads `modelDefinition.id` for the wire
      // payload, so override here so backend wallet/quota lookup keys match
      // what live chat sends.
      modelDefinition: { ...params.modelDefinition, id: params.modelId },
      systemPrompt: prepared.enhancedSystemPrompt,
      ...(prepared.resolvedTemperature != null
        ? { temperature: prepared.resolvedTemperature }
        : {}),
      tools: tracedTools,
      ...(params.selectedServers.length
        ? { selectedServerIds: params.selectedServers }
        : {}),
      mcpClientManager: params.mcpClientManager,
      authContext: params.evalAuthContext,
      sourceType: "eval",
      origin: "eval",
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      // Harness eval (host harness === "claude-code"): forward the selector and
      // the host's real approval intent so runHarnessTurn fail-closes on a
      // requireToolApproval host (it can't do interactive approval yet) while
      // still running non-approval hosts under allow-all. Gated on harness so
      // emulated evals stay byte-identical (they forward neither today).
      // `harness` moved to `runtime` above; `requireToolApproval` + `projectId`
      // stay top-level engine options (still harness-gated so emulated evals
      // remain byte-identical — runHarnessTurn needs projectId for the host's
      // computer; authHeader rides authContext.token).
      ...(params.harness
        ? {
            ...(params.requireToolApproval !== undefined
              ? { requireToolApproval: params.requireToolApproval }
              : {}),
            ...(params.projectId ? { projectId: params.projectId } : {}),
          }
        : {}),
      ...(abortSignal ? { abortSignal } : {}),
      maxSteps: params.maxSteps,
      progressivePlan: prepared.progressivePlan,
      discoveryState: prepared.discoveryState,
      ...(sinks.onLiveTextDelta
        ? { onLiveTextDelta: sinks.onLiveTextDelta }
        : {}),
      // Browser-rendered MCP App eval (PR 14): cache tool-call inputs for the
      // widget shim, render MCP App tool results in the harness (the engine
      // awaits the hook, so a mounted widget is visible to the next step's
      // gate), and hide `computer` / `finish_widget` until a widget has
      // actually rendered. SSE sinks compose around the browser hooks:
      // `onToolResult` SSE fires BEFORE the render so live consumers don't
      // wait on Chromium.
      onToolCall: (event) => {
        browser.noteToolCallInput(event);
        sinks.onToolCall?.(event);
      },
      onToolResult: async (event) => {
        await sinks.onToolResult?.(event);
        await browser.handleEngineToolResult(event);
      },
      ...(sinks.onStepFinish ? { onStepFinish: sinks.onStepFinish } : {}),
      onEngineError: (event) => {
        lastEngineError = event;
      },
      ...(browser.prepareAdvertisedTools
        ? { prepareAdvertisedTools: browser.prepareAdvertisedTools }
        : {}),
    });
  } catch (error) {
    return mapThrownTurnError(error, "runAssistantTurn");
  }

  // Cancellation that fired DURING `runAssistantTurn` without surfacing as a
  // throw: the engine catches AbortError, sets its internal `aborted` flag,
  // omits the `turnTrace`, and returns normally. Without this check we'd
  // fall through to the silent-cycle-failure branch below and record an
  // aborted run as a verdict failure.
  if (isAborted()) {
    logger.debug(
      `[evals] backend iteration${logSuffix} aborted mid-turn; skipping record`
    );
    return { kind: "cancelled" };
  }

  // Drain per-turn outputs into the iteration-level accumulators BEFORE the
  // failure checks below — preserves whatever partial good state the engine
  // produced (tool spans, partial transcript, usage), so the persisted
  // iteration shows what completed before the failure point.
  //
  // Codex round-3 (P2 "Preserve backend tool step indices"): the wrap's tool
  // spans land with `stepIndex: -1` (no `prepareStep` bridge to the engine);
  // the engine's own LLM-step spans land on `turnTrace.spans` with correct
  // per-step indices. Merge both.
  acc.capturedSpans.push(...traceCtx.recordedSpans);
  if (turnResult.turnTrace?.spans?.length) {
    acc.capturedSpans.push(...turnResult.turnTrace.spans);
  }
  // Reconcile accumulated usage to the engine's canonical post-turn total
  // against the pre-turn baseline. The stream runner's `onStepFinish` sink
  // rolls `accumulatedUsage` per step for live snapshots; this final
  // assignment lands on the same value (PR 4b "totalUsage merged BEFORE
  // failure branches" invariant).
  if (turnResult.usage) {
    acc.accumulatedUsage.inputTokens =
      baselineUsage.inputTokens + (turnResult.usage.inputTokens ?? 0);
    acc.accumulatedUsage.outputTokens =
      baselineUsage.outputTokens + (turnResult.usage.outputTokens ?? 0);
    acc.accumulatedUsage.totalTokens =
      baselineUsage.totalTokens + (turnResult.usage.totalTokens ?? 0);
  }

  // Per-turn tool calls — rebuild from THIS turn's new messages only (the
  // facade computes the slice once as `newMessages`, so prior turns' calls
  // aren't double-counted). Replaces whatever the live `onToolCall` sink
  // accumulated so the grader sees the canonical shape.
  const newMessages = turnResult.newMessages;
  const canonicalPromptToolsCalled = params.extractToolCalls(newMessages);
  promptToolsCalled.length = 0;
  promptToolsCalled.push(...canonicalPromptToolsCalled);

  // Per-turn signals for per-turn checks — same capture the local runners do,
  // so the shared verdict helper evaluates PromptTurn.checks on hosted evals
  // too. This turn's assistant text + tool errors, scoped to this turn's new
  // messages and spans (wrap tool spans + the engine's turnTrace spans).
  acc.assistantMessageByPrompt[promptIndex] =
    extractFinalAssistantMessage(newMessages);
  acc.toolErrorsByPrompt[promptIndex] = extractToolErrors({
    spans: [...traceCtx.recordedSpans, ...(turnResult.turnTrace?.spans ?? [])],
    messages: newMessages as Array<{ role: string; content: unknown }>,
  });

  // Roll the engine's transcript forward as the next turn's starting point.
  acc.messageHistory.length = 0;
  acc.messageHistory.push(...turnResult.messages);

  // Failure detection (ordered most-specific → least-specific). Three engine
  // failure shapes the runner must catch:
  //
  //  (a) Engine catch fired AFTER partial messages were appended — the
  //      engine's `executeEngine` catch leaves `runSucceeded: false` →
  //      `turnTrace` is NOT captured even though messages may have grown.
  //      `!turnTrace` is the reliable signal.
  //  (b) Engine succeeded (turnTrace captured) but produced no new content
  //      (step-level non-OK → `shouldContinue: false`, synthetic finish).
  //      Detect via `newMessages.length === 0`.
  //  (c) Step 1 succeeded, a later step errored: `turnTrace` captured,
  //      messages grew, but `turnTrace.spans` carries a non-tool
  //      error-status span.
  //
  // PR 5b-followup-2: prefer the engine's captured structured error when
  // present (429 daily-cap text, hosted-model setup errors, …) over the
  // generic fallbacks.
  const failTurn = (
    fallbackError: string,
    logLine: string
  ): HostedEvalTurnOutcome => {
    const failure = lastEngineError
      ? {
          iterationError: lastEngineError.message,
          iterationErrorDetails: lastEngineError.rawText,
        }
      : { iterationError: fallbackError };
    logger.error(logLine);
    sinks.onTurnFailure?.(failure);
    return { kind: "failed", ...failure };
  };

  if (!turnResult.turnTrace) {
    return failTurn(
      "Backend stream failed during iteration (engine caught an error mid-turn)",
      `[evals] runAssistantTurn${logSuffix} returned no turnTrace (engine runSucceeded=false); treating as cycle failure (messagesGrew=${
        newMessages.length > 0
      }, engineError=${
        lastEngineError ? (lastEngineError.code ?? "uncoded") : "none"
      })`
    );
  }
  if (newMessages.length === 0) {
    return failTurn(
      "Backend step returned no content (stream error or empty response)",
      `[evals] runAssistantTurn${logSuffix} produced no new messages this turn; treating as cycle failure (engineError=${
        lastEngineError ? (lastEngineError.code ?? "uncoded") : "none"
      })`
    );
  }
  // Cursor / Codex review fix: filter to backend step / LLM failure spans
  // only — exclude `category: "tool"` AND any span carrying a `toolCallId`
  // (the child error span `wrapToolSetForEvalTrace` emits alongside a failed
  // tool span). Tool-category error spans flow through the configured
  // `failOnToolError` gate; treating them as cycle failures here would
  // defeat that policy.
  const stepErrorSpan = turnResult.turnTrace.spans.find(
    (span) =>
      span.status === "error" &&
      span.category !== "tool" &&
      !(span as { toolCallId?: string }).toolCallId
  );
  if (stepErrorSpan) {
    return failTurn(
      `Backend step failed mid-turn: ${stepErrorSpan.name}`,
      `[evals] runAssistantTurn${logSuffix} turnTrace has non-tool error-status span; treating as cycle failure (span=${
        stepErrorSpan.name
      } category=${stepErrorSpan.category} engineError=${
        lastEngineError ? (lastEngineError.code ?? "uncoded") : "none"
      })`
    );
  }

  sinks.onTurnSuccess?.();
  return { kind: "completed" };
}
