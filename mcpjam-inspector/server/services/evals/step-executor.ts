/**
 * step-executor.ts — the single sequential executor over a unified `TestStep[]`.
 *
 * Replaces the old model-vs-pinned per-turn binary (`runIterationWithAiSdk`'s
 * `for promptIndex … isPinnedTurn` loop and its three siblings) with ONE
 * in-order executor. Each step reads/mutates an explicit {@link
 * StepExecutionState}; an `assert` step evaluates against a point-in-time
 * snapshot of that state at its exact position (strictly more expressive than
 * the old turn-scoped checks).
 *
 * Engine boundary: the two model/tool engines (`runDirectChatTurn` /
 * `runPinnedTurn`, plus the hosted backend driver) differ in wiring per runner
 * variant, so the executor does NOT own them — it accepts `onPrompt` /
 * `onToolCall` handlers that the caller supplies (the "three terminals" — SSE,
 * recorder, grader — attach as adapters over those handlers' own callbacks).
 * The executor OWNS `interact` and `assert`, which only touch the shared
 * browser session context + the `@mcpjam/sdk` predicate engine, so those live
 * in exactly one place across all four runner paths.
 *
 * Transcript boundary (Phase 2): only `prompt` / `toolCall` steps append to
 * `state.messages` (→ chatSessions transcript). `interact` / `assert` land on
 * `testIteration` via `assertionResults` / browser-interaction records — they
 * MUST NOT leak into the chatSessions writer.
 */

import type { ModelMessage } from "ai";
import type {
  PredicateResult,
  ToolErrorRecord,
} from "@/shared/eval-matching";
import {
  buildIterationTranscript,
  evaluatePredicates,
  extractFinalAssistantMessage,
  summarizeRenderObservations,
  widgetCallToToolCall,
} from "@/shared/eval-matching";
import type { ToolCall } from "@/shared/eval-matching";
import type { RunnerWidgetRenderObservation } from "@/shared/eval-trace";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import {
  isAssertStep,
  isInteractStep,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  stepTurnIndices,
  type AssertStep,
  type InteractStep,
  type PromptStep,
  type TestStep,
  type ToolCallStep,
} from "@/shared/steps";
import type { BrowserSessionContext } from "../browser-session-context";
import { MAX_WIDGET_FOLLOWUP_TURNS } from "./drive-hosted-eval-turn.js";
import { logger } from "../../utils/logger.js";

/** Accumulated token usage in AI-SDK-canonical shape. */
export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * One verdict-bearing record per `assert` step, keyed by the step's id +
 * position. Replaces the old per-turn `metadata.predicates`. A
 * `PredicateResult` for a transcript predicate; a synthesized result for a
 * DOM-level `WidgetAssertion` (no SDK `Predicate` exists for those).
 */
export interface StepAssertionResult {
  stepId: string;
  stepIndex: number;
  passed: boolean;
  reason: string;
  /** The transcript-predicate verdict, when the assert was a `Predicate`. */
  predicateResult?: PredicateResult;
}

/** A fail-closed `interact` outcome (widget not mounted / wrong tool). */
export interface InteractionFailure {
  stepId: string;
  stepIndex: number;
  toolName: string;
  reason: string;
}

/**
 * The explicit execution state threaded through every step. An `assert`
 * snapshots this at its exact position.
 */
export interface StepExecutionState {
  /** Transcript messages — ONLY `prompt`/`toolCall` steps append here. */
  messages: ModelMessage[];
  /** Every observed/executed tool call across the run, in order. */
  toolCalls: ToolCall[];
  /**
   * The SAME tool calls bucketed by TURN ordinal (`stepTurnIndices`), so the
   * verdict adapter feeds `evaluateMultiTurnResults(promptTurns, toolCallsByTurn)`
   * with zero reconstruction. A `prompt`/`toolCall` step's calls land in its own
   * turn; an `interact` step's widget→host calls land in the current (last-opened)
   * turn — identical to the legacy runner's `promptIndex` bucketing + the
   * `widgetToolCallsByPromptIndex` merge. Bucket contract: see the plan.
   */
  toolCallsByTurn: ToolCall[][];
  /** Tool failures observed outside any trace (pinned calls, etc.). */
  toolErrors: ToolErrorRecord[];
  /** Render observations the browser session collected (live reference). */
  widgetRenderObservations: readonly RunnerWidgetRenderObservation[];
  /** One entry per `assert` step. */
  assertionResults: StepAssertionResult[];
  /** Fail-closed interaction failures (any ⇒ iteration fails). */
  interactionFailures: InteractionFailure[];
  /**
   * Steps that never ran because fail-fast halted execution at an earlier failed
   * `assert`/`interact`. Persisted (PR6) so a non-live suite result explains why
   * later checks are absent; surfaced as "Skipped" in the step UI.
   */
  skippedSteps: SkippedStep[];
  /** Accumulated usage across `prompt` steps. */
  usage: UsageSummary;
}

/** A step that fail-fast skipped (an earlier step failed). */
export interface SkippedStep {
  stepId: string;
  stepIndex: number;
  kind: TestStep["kind"];
  /** The failing step that triggered the halt. */
  reason: string;
}

export function createStepExecutionState(): StepExecutionState {
  return {
    messages: [],
    toolCalls: [],
    toolCallsByTurn: [],
    toolErrors: [],
    widgetRenderObservations: [],
    assertionResults: [],
    interactionFailures: [],
    skippedSteps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

/** Outcome the caller's engine handlers return for a `prompt`/`toolCall` step. */
export interface StepEngineOutcome {
  /** Transcript messages produced by this step (appended to `state.messages`). */
  messages?: ModelMessage[];
  /** Tool calls observed/executed during this step. */
  toolCalls?: ToolCall[];
  /** Tool failures observed during this step (folded into the transcript). */
  toolErrors?: ToolErrorRecord[];
  /** Usage delta for this step (`prompt` only; `toolCall` issues none). */
  usage?: Partial<UsageSummary>;
  /**
   * A fatal, iteration-level error (e.g. stream returned nothing, pinned
   * server not connected). Stops the executor; the caller's verdict gate reads
   * it via the returned `iterationError`.
   */
  iterationError?: string;
  iterationErrorDetails?: string;
  /**
   * When true, the iterationError is a SETUP failure (status:"failed"), not an
   * assertion failure (status:"completed"+error). Mirrors the pinned
   * not-connected behavior.
   */
  setupFailure?: boolean;
}

export interface StepExecutorHandlers {
  /**
   * Drive one model-driven `prompt` step through the shared engine
   * (`runDirectChatTurn` / hosted backend driver). `stepIndex` is the position
   * in the full `TestStep[]`; `turnOrdinal` is the TURN index from
   * `stepTurnIndices` (advances on `prompt` AND `toolCall`) — the unified
   * ordinal that also stamps `setActivePromptIndex` and the tool-call buckets,
   * so trace/SSE `promptIndex`, browser artifacts, and the matcher feed all
   * agree. (Equals the legacy `promptIndex` when no pinned `toolCall` steps are
   * interleaved.)
   */
  onPrompt(args: {
    step: PromptStep;
    stepIndex: number;
    turnOrdinal: number;
  }): Promise<StepEngineOutcome>;
  /**
   * Execute one deterministic `toolCall` step (`runPinnedTurn` + render). Same
   * `turnOrdinal` scheme as `onPrompt` for stamping the synthetic toolCallId.
   */
  onToolCall(args: {
    step: ToolCallStep;
    stepIndex: number;
    turnOrdinal: number;
  }): Promise<StepEngineOutcome>;
  /**
   * Drive ONE model continuation turn seeded by a widget `ui/message` follow-up
   * captured during an `interact` step (the run-side analogue of Playground's
   * `useChat` auto-continue). Shares the interact's `turnOrdinal` so the
   * resulting tool calls bucket into that turn — exactly where a turn-scoped
   * `toolCalledWith` assert reads them. Optional: only the production handlers
   * implement it; the executor no-ops when it's absent.
   */
  onFollowUp?(args: {
    text: string;
    stepIndex: number;
    turnOrdinal: number;
  }): Promise<StepEngineOutcome>;
}

export interface StepExecutorResult {
  state: StepExecutionState;
  /** Set when a `prompt`/`toolCall` step reported a fatal error. */
  iterationError?: string;
  iterationErrorDetails?: string;
  /** True when `iterationError` is a setup (not assertion) failure. */
  setupFailure: boolean;
}

/** True when the case has any `interact`/widget-`assert` step needing a live widget. */
export function hasWidgetDrivingStep(steps: TestStep[]): boolean {
  return steps.some(
    (s) =>
      isInteractStep(s) ||
      (isAssertStep(s) && isWidgetAssertion(s.assertion)),
  );
}

/**
 * Record tool calls in BOTH the flat in-order list (point-in-time predicate
 * snapshots) and the per-turn bucket (matcher feed). `turn` is the
 * `stepTurnIndices` ordinal of the step that produced them.
 */
function recordToolCalls(
  state: StepExecutionState,
  turn: number,
  calls: ToolCall[],
): void {
  if (calls.length === 0) return;
  state.toolCalls.push(...calls);
  (state.toolCallsByTurn[turn] ??= []).push(...calls);
}

function applyOutcome(
  state: StepExecutionState,
  outcome: StepEngineOutcome,
  turn: number,
): void {
  if (outcome.messages?.length) state.messages.push(...outcome.messages);
  if (outcome.toolCalls?.length) recordToolCalls(state, turn, outcome.toolCalls);
  if (outcome.toolErrors?.length) state.toolErrors.push(...outcome.toolErrors);
  if (outcome.usage) {
    state.usage.inputTokens += outcome.usage.inputTokens ?? 0;
    state.usage.outputTokens += outcome.usage.outputTokens ?? 0;
    state.usage.totalTokens += outcome.usage.totalTokens ?? 0;
  }
}

/** Snapshot the state as an `IterationTranscript` for point-in-time predicate eval. */
function snapshotTranscript(state: StepExecutionState) {
  const finalAssistantMessage = extractFinalAssistantMessage(state.messages);
  return buildIterationTranscript({
    toolCalls: state.toolCalls,
    ...(finalAssistantMessage !== undefined
      ? { finalAssistantMessage }
      : {}),
    usage:
      state.usage.inputTokens ||
      state.usage.outputTokens ||
      state.usage.totalTokens
        ? state.usage
        : undefined,
    renderObservations: summarizeRenderObservations(
      state.widgetRenderObservations,
    ),
    toolErrors: state.toolErrors,
  });
}

async function runInteractStep(
  step: InteractStep,
  stepIndex: number,
  turn: number,
  browser: Pick<BrowserSessionContext, "replayInteractStep">,
  state: StepExecutionState,
): Promise<void> {
  const outcome = await browser.replayInteractStep(step.toolName, step.action);
  // Fold any widget→host tool calls this action triggered into the transcript
  // timeline, in order, so a later `toolCalledWith` assert sees widget-initiated
  // calls exactly like model-initiated ones (point-in-time eval against
  // `state.toolCalls`). They also bucket into the interact's CURRENT turn, so the
  // matcher sees them as actuals for that turn (mirrors `widgetToolCallsByPromptIndex`).
  if (outcome.widgetToolCalls?.length) {
    recordToolCalls(
      state,
      turn,
      outcome.widgetToolCalls.map(widgetCallToToolCall),
    );
  }
  // Fail closed: a not-mounted / ambiguous (wrong-tool) widget fails the
  // iteration. A successful action that the harness reports failed (e.g. the
  // locator didn't resolve) is ALSO a fail-closed interaction failure — the
  // recorded scenario could not be reproduced.
  if (!outcome.ok) {
    state.interactionFailures.push({
      stepId: step.id,
      stepIndex,
      toolName: step.toolName,
      reason: outcome.reason ?? `interact "${step.action.kind}" failed`,
    });
  }
}

/**
 * After a SUCCESSFUL `prompt` / `toolCall` / `interact` step, drain any widget
 * `ui/message` follow-ups and replay each as a model continuation turn (the
 * headless analogue of Playground's `useChat` auto-continue). R3 consolidation:
 * this is the SINGLE follow-up loop for both local and hosted (the hosted
 * per-turn recursion was deleted), called after every authored step so a widget
 * that emits a message during a prompt turn (auto-send on render) is driven the
 * same as one from an interact click.
 *
 * Bounded by {@link MAX_WIDGET_FOLLOWUP_TURNS} **per authored step** (the budget
 * resets each call). Each turn's outcome is folded into the *spawning* step's
 * `turn` via {@link applyOutcome}, so its tool calls land in
 * `state.toolCallsByTurn[turn]` — where a turn-scoped `toolCalledWith` assert
 * reads them. Returns an iteration error string on the first failed follow-up
 * turn, else `undefined`. No-op when the handler doesn't implement `onFollowUp`;
 * for the common eval (no widget `ui/message`) `drainFollowUps()` returns `[]`
 * and this is a no-op beyond one log line.
 *
 * MUST be called only after the step's own fail-fast guard passed — never drain
 * from a half-applied/failed step.
 */
async function drainAndDriveFollowUps(
  stepLabel: string,
  stepIndex: number,
  turn: number,
  browser: Pick<BrowserSessionContext, "drainFollowUps">,
  handlers: StepExecutorHandlers,
  state: StepExecutionState,
): Promise<string | undefined> {
  if (!handlers.onFollowUp) return undefined;
  let remaining = MAX_WIDGET_FOLLOWUP_TURNS;
  while (remaining > 0) {
    const followUps = browser.drainFollowUps();
    // Observability: a non-empty drain proves a `ui/message` was sent; an empty
    // drain after a 🛒-style click means the locator hit a non-interactive node
    // (no message sent) — the real bug then is the locator, not the runner.
    logger.info(
      `[evals] ${stepLabel} (step ${stepIndex}) drained ${followUps.length} widget ui/message follow-up(s)`,
    );
    if (followUps.length === 0) break;
    for (const text of followUps) {
      if (remaining <= 0) {
        logger.warn(
          `[evals] widget follow-up budget exhausted at step ${stepIndex}; dropping further ui/message follow-ups`,
        );
        return undefined;
      }
      remaining -= 1;
      const outcome = await handlers.onFollowUp!({ text, stepIndex, turnOrdinal: turn });
      applyOutcome(state, outcome, turn);
      if (outcome.iterationError) return outcome.iterationError;
    }
  }
  return undefined;
}

async function runAssertStep(
  step: AssertStep,
  stepIndex: number,
  browser: Pick<BrowserSessionContext, "evaluateWidgetAssertion">,
  state: StepExecutionState,
): Promise<void> {
  if (isWidgetAssertion(step.assertion)) {
    // DOM-level assertion: evaluate against the live widget. Fails closed when
    // the targeted widget isn't mounted.
    const outcome = await browser.evaluateWidgetAssertion(
      step.assertion.toolName,
      step.assertion,
    );
    state.assertionResults.push({
      stepId: step.id,
      stepIndex,
      passed: outcome.ok,
      reason: outcome.ok
        ? `widget assertion "${step.assertion.kind}" passed`
        : outcome.reason ??
          `widget assertion "${step.assertion.kind}" failed`,
    });
    return;
  }
  // Transcript-level predicate: evaluate against the state snapshot at this
  // exact position (point-in-time).
  const [result] = evaluatePredicates(snapshotTranscript(state), [
    step.assertion,
  ]);
  state.assertionResults.push({
    stepId: step.id,
    stepIndex,
    passed: result?.passed ?? false,
    reason: result?.reason ?? "predicate evaluation produced no result",
    ...(result ? { predicateResult: result } : {}),
  });
}

/** Record `steps[fromIndex…]` as fail-fast-skipped (an earlier step failed). */
function recordSkippedSteps(
  state: StepExecutionState,
  steps: TestStep[],
  fromIndex: number,
  reason: string,
): void {
  for (let i = fromIndex; i < steps.length; i++) {
    const s = steps[i]!;
    state.skippedSteps.push({
      stepId: s.id,
      stepIndex: i,
      kind: s.kind,
      reason,
    });
  }
}

/**
 * Execute a `TestStep[]` sequentially against `state`, dispatching engine
 * (`prompt`/`toolCall`) steps to the caller's handlers and owning
 * `interact`/`assert`. Stops on the first fatal engine error OR the first failed
 * `assert`/`interact` (fail-fast) — remaining steps are recorded as Skipped. The
 * verdict stays correct: a halted run can't have passed the steps it never ran.
 */
export async function executeSteps(args: {
  steps: TestStep[];
  state: StepExecutionState;
  browser: Pick<
    BrowserSessionContext,
    | "replayInteractStep"
    | "evaluateWidgetAssertion"
    | "setKeepWidgetsMountedForSteps"
    | "setActivePromptIndex"
    | "setActiveAuthoredStepId"
    | "widgetRenderObservations"
    | "drainFollowUps"
  >;
  handlers: StepExecutorHandlers;
  /** Aborted check — when true at a step boundary the executor stops early. */
  isAborted?: () => boolean;
  /**
   * Per-step status hook (PR5): fires `running` when a step starts, then
   * `ok`/`fail` on completion, and `skipped` for every step fail-fast never ran.
   * The streaming runner forwards these as `step_status` SSE events keyed by
   * `stepId` so the editor ticks individual cards.
   */
  onStepStatus?: (event: {
    stepId: string;
    stepIndex: number;
    kind: TestStep["kind"];
    turnOrdinal: number;
    status: EvalStepStatus;
  }) => void;
}): Promise<StepExecutorResult> {
  const { steps, state, browser, handlers, isAborted, onStepStatus } = args;

  // Bind the state's render-observation field to the browser session's live
  // array (a stable reference the session pushes into as widgets render). This
  // is what makes a `widgetRendered` transcript assert see the renders that
  // already happened — `snapshotTranscript` reads `state.widgetRenderObservations`
  // point-in-time, and createStepExecutionState() seeds it with an empty array.
  state.widgetRenderObservations = browser.widgetRenderObservations;

  // Keep rendered widgets mounted when a later interact/assert needs to drive
  // them. Set once up front so the render hooks honor it from the first render.
  if (hasWidgetDrivingStep(steps)) {
    browser.setKeepWidgetsMountedForSteps(true);
  }

  // Canonical turn ordinal per step (the bucket contract): a `prompt`/`toolCall`
  // opens a turn; `interact`/`assert` fold into the current turn. One ordinal
  // drives `setActivePromptIndex` stamping, the handler `turnOrdinal`, and the
  // `toolCallsByTurn` bucket — so artifacts, trace `promptIndex`, and the matcher
  // feed never diverge (the former split prompt/call counters could, on a pinned
  // `toolCall` interleaved with prompts).
  const turnByStep = stepTurnIndices(steps);

  const emitStatus = (idx: number, status: EvalStepStatus) => {
    if (!onStepStatus) return;
    const s = steps[idx]!;
    onStepStatus({
      stepId: s.id,
      stepIndex: idx,
      kind: s.kind,
      turnOrdinal: turnByStep[idx]!,
      status,
    });
  };
  const emitSkipped = (fromIndex: number) => {
    for (let i = fromIndex; i < steps.length; i++) emitStatus(i, "skipped");
  };

  // R3: after a SUCCESSFUL step, drain + drive any widget `ui/message` follow-ups
  // into the step's turn. Returns a fail-fast `StepExecutorResult` when a
  // follow-up turn errored (caller returns it), else `undefined` (caller goes on).
  const runFollowUps = async (
    label: string,
    sIdx: number,
    turn: number,
  ): Promise<StepExecutorResult | undefined> => {
    const err = await drainAndDriveFollowUps(
      label,
      sIdx,
      turn,
      browser,
      handlers,
      state,
    );
    if (!err) return undefined;
    emitStatus(sIdx, "fail");
    recordSkippedSteps(
      state,
      steps,
      sIdx + 1,
      `widget follow-up turn errored (step ${sIdx}): ${err}`,
    );
    emitSkipped(sIdx + 1);
    return { state, iterationError: err, setupFailure: false };
  };

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    if (isAborted?.()) break;
    const step = steps[stepIndex]!;
    const turnOrdinal = turnByStep[stepIndex]!;
    // Stamp every artifact this step produces (renders, interaction rows) with
    // the authored step id so the replay Steps view buckets by authored step.
    // Set for ALL kinds (incl. interact/assert, which don't advance promptIndex).
    browser.setActiveAuthoredStepId(step.id);

    if (isPromptStep(step)) {
      // Stamp artifacts (render observations, browser steps) with the turn
      // ordinal so per-turn grouping (`promptIndex`) stays meaningful.
      browser.setActivePromptIndex(turnOrdinal);
      emitStatus(stepIndex, "running");
      const outcome = await handlers.onPrompt({ step, stepIndex, turnOrdinal });
      applyOutcome(state, outcome, turnOrdinal);
      if (outcome.iterationError) {
        emitStatus(stepIndex, "fail");
        recordSkippedSteps(
          state,
          steps,
          stepIndex + 1,
          `step ${stepIndex} errored: ${outcome.iterationError}`,
        );
        emitSkipped(stepIndex + 1);
        return {
          state,
          iterationError: outcome.iterationError,
          iterationErrorDetails: outcome.iterationErrorDetails,
          setupFailure: outcome.setupFailure === true,
        };
      }
      // A widget rendered during this prompt turn may have emitted a `ui/message`
      // (auto-send on render). Drive it like an interact follow-up (R3).
      const followUpResult = await runFollowUps(
        `prompt`,
        stepIndex,
        turnOrdinal,
      );
      if (followUpResult) return followUpResult;
      emitStatus(stepIndex, "ok");
      continue;
    }

    if (isToolCallStep(step)) {
      browser.setActivePromptIndex(turnOrdinal);
      emitStatus(stepIndex, "running");
      const outcome = await handlers.onToolCall({
        step,
        stepIndex,
        turnOrdinal,
      });
      applyOutcome(state, outcome, turnOrdinal);
      if (outcome.iterationError) {
        emitStatus(stepIndex, "fail");
        recordSkippedSteps(
          state,
          steps,
          stepIndex + 1,
          `step ${stepIndex} errored: ${outcome.iterationError}`,
        );
        emitSkipped(stepIndex + 1);
        return {
          state,
          iterationError: outcome.iterationError,
          iterationErrorDetails: outcome.iterationErrorDetails,
          setupFailure: outcome.setupFailure === true,
        };
      }
      // A widget rendered by this pinned tool call may have emitted a `ui/message`.
      const followUpResult = await runFollowUps(
        `toolCall "${step.toolName}"`,
        stepIndex,
        turnOrdinal,
      );
      if (followUpResult) return followUpResult;
      emitStatus(stepIndex, "ok");
      continue;
    }

    if (isInteractStep(step)) {
      emitStatus(stepIndex, "running");
      const failuresBefore = state.interactionFailures.length;
      await runInteractStep(step, stepIndex, turnOrdinal, browser, state);
      if (state.interactionFailures.length > failuresBefore) {
        // Fail-fast: a failed interaction halts the run; later steps are Skipped.
        emitStatus(stepIndex, "fail");
        recordSkippedSteps(
          state,
          steps,
          stepIndex + 1,
          `interact "${step.toolName}" failed (step ${stepIndex})`,
        );
        emitSkipped(stepIndex + 1);
        break;
      }
      // Replay any widget `ui/message` follow-up this interaction emitted as a
      // real model turn — the headless analogue of Playground's
      // `useChat` auto-continue. The model runs and may call a tool (e.g.
      // `view-cart`), bucketed into THIS interact's turn so a later turn-scoped
      // assert sees it. The drained-count log is the load-bearing observability:
      // a click that sent NO message (e.g. a missed locator) drains empty here.
      const followUpResult = await runFollowUps(
        `interact "${step.toolName}"`,
        stepIndex,
        turnOrdinal,
      );
      if (followUpResult) return followUpResult;
      emitStatus(stepIndex, "ok");
      continue;
    }

    if (isAssertStep(step)) {
      emitStatus(stepIndex, "running");
      await runAssertStep(step, stepIndex, browser, state);
      const last = state.assertionResults[state.assertionResults.length - 1];
      if (last && !last.passed) {
        // Fail-fast: a failed assertion halts the run; later steps are Skipped.
        emitStatus(stepIndex, "fail");
        recordSkippedSteps(
          state,
          steps,
          stepIndex + 1,
          `assert failed (step ${stepIndex}): ${last.reason}`,
        );
        emitSkipped(stepIndex + 1);
        break;
      }
      emitStatus(stepIndex, "ok");
      continue;
    }
  }

  // Clear so artifacts recorded after the step loop stay legacy-shaped. (Each
  // iteration uses a fresh browser session, so this is tidiness, not isolation;
  // the early-return error paths above don't bother — the browser is disposed.)
  browser.setActiveAuthoredStepId(null);

  return { state, setupFailure: false };
}

/**
 * The iteration verdict from the executor's state: ALL `assert` steps passed
 * AND no fail-closed interaction failure AND no fatal engine error. This is the
 * unified-model replacement for the old `evaluateMultiTurnResults` +
 * per-turn-checks + `scriptedCheckFailures` verdict spread.
 *
 * Note: an `iterationError` is supplied separately by the caller (it folds it
 * through `finalizePassedForEval` alongside `failOnToolError`); this helper
 * answers only "did the authored assertions all pass?".
 */
export function stepsVerdict(state: StepExecutionState): {
  passed: boolean;
  failedAsserts: StepAssertionResult[];
} {
  const failedAsserts = state.assertionResults.filter((r) => !r.passed);
  const passed =
    failedAsserts.length === 0 && state.interactionFailures.length === 0;
  return { passed, failedAsserts };
}
