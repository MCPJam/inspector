/**
 * Shared stream-turn driver.
 *
 * Both inspector chat engines — the emulated Convex `/stream` loop
 * (`mcpjam-stream-handler.ts`) and the real harness loop
 * (`harness/run-harness-turn.ts`) — independently reconstructed the same
 * per-turn ritual: emit `turn_start`, accumulate trace spans, fire the
 * `onStepFinish` contract (cumulative usage + a defensive `turnSpans` copy +
 * `settledWithError`), gate aborts so a cancelled turn writes no terminal
 * chunk, emit the safety `finish` chunk + `turn_finish`, assemble a
 * `PersistedTurnTrace`, and return a `ChatEngineLoopResult`.
 *
 * This driver owns that ritual so the two engines share one implementation and
 * produce identical live-trace + step-finish semantics. It deliberately does
 * NOT own:
 *   - trace SNAPSHOT cadence — the engines emit `emitTraceSnapshot` at
 *     engine-specific points (harness per step in `finishStep`; emulated
 *     multiple times inside `processOneStep`), so each engine still calls
 *     `emitTraceSnapshot(writer, messages, tools, driver.snapshotContext(...))`
 *     where it needs to;
 *   - span CONSTRUCTION — harness builds synthetic wall-clock llm spans, the
 *     emulated engine builds backend-step spans; each pushes into the shared
 *     `spans` array the driver tracks;
 *   - message/transcript construction — engine-specific (harness hand-builds
 *     MCPJam-shaped messages from `fullStream`; the emulated engine accumulates
 *     `contentParts` per Convex step). The driver only reads the final
 *     `messageHistory` for the result + trace snapshots.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { FinishReason, UIMessageChunk } from "ai";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  CURRENT_TURN_OUTCOME_CONTRACT_VERSION,
  TURN_CANCELLATION_SOURCES,
  type DeadlineClock,
  type TimeoutMetadata,
  type TurnCancellationSource,
  type TurnErrorSource,
  type TurnLifecycle,
  type TurnModelAccess,
  type TurnOutcomeRecord,
  type TurnPauseKind,
  type TurnRuntimeEngine,
  type UnresolvedToolCallState,
} from "@/shared/turn-outcome";

/** One row of `termination.unresolvedToolCalls`. */
export type TurnOutcomeUnresolvedToolCall = NonNullable<
  NonNullable<TurnOutcomeRecord["termination"]>["unresolvedToolCalls"]
>[number];
import { deadlineClockOf } from "./run-supervisor/deadline.js";
import type { PersistedTurnTrace } from "./chat-ingestion.js";
import {
  getPromptMessageStartIndex,
  writeTraceEvent,
  type LiveTraceSnapshotTurnContext,
} from "./live-chat-trace-stream.js";
import { logger } from "./logger.js";

/** Minimal writer matching `createUIMessageStream`'s `execute` arg + the no-op
 *  (`streamSink: "none"`) writer. */
export type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** The `onStepFinish` payload shape both engines fire (mirrors
 *  `MCPJamStepFinishEvent`). Kept structural so the driver doesn't import the
 *  handler module (avoids a cycle). */
export interface StreamTurnStepFinish {
  stepIndex: number;
  promptIndex: number;
  turnUsage?: UsageTokens;
  settledWithError: boolean;
  turnSpans: EvalTraceSpan[];
}

export interface StreamTurnResult {
  response?: Response;
  messageHistory: ModelMessage[];
  turnTrace?: PersistedTurnTrace;
  aborted: boolean;
}

export interface StreamTurnDriverOptions {
  turnId: string;
  promptIndex: number;
  modelId: string;
  engine?: "emulated" | "harness";
  harness?: string;
  /** Span-offset zero point — set to STREAM start (after setup), so live and
   *  rehydrated traces align. Both engines clock spans from here. */
  traceBaseMs: number;
  /** Shared, hoisted span array the engine pushes into; the driver snapshots
   *  + persists it. */
  spans: EvalTraceSpan[];
  onStepFinish?: (event: StreamTurnStepFinish) => void;
  /**
   * The turn's outcome builder, created at ENGINE ENTRY and shared with this
   * driver so `buildPersistedTrace` can stamp the record.
   *
   * Passed in rather than owned: the harness only builds its driver once the
   * model stream resolves, and the endings that most need a record — an abort
   * during box wake, a setup failure — happen before that.
   */
  outcome?: TurnOutcomeBuilder;
}

/**
 * Owns the per-turn ritual shared by both engines. The engine constructs it
 * once per turn, pushes spans into `driver.spans`, updates `driver.usage`/
 * `driver.finishReason` as the stream settles, and calls the lifecycle methods
 * in its existing order.
 */
export class StreamTurnDriver {
  readonly turnId: string;
  readonly promptIndex: number;
  readonly modelId: string;
  readonly engine?: "emulated" | "harness";
  readonly harness?: string;
  readonly traceBaseMs: number;
  readonly spans: EvalTraceSpan[];
  readonly outcome?: TurnOutcomeBuilder;

  /** Cumulative per-turn usage (NOT per-step delta); set by the engine as the
   *  stream's `finish`/step usage settles. */
  usage: UsageTokens | undefined;
  finishReason: FinishReason = "stop";

  /** Set true once `turn_start` is emitted, so an error/finish path can avoid
   *  emitting a phantom turn before the stream began. */
  private started = false;
  /** Set true by `finishTurn` on a clean settle; gates persistence. */
  succeeded = false;

  private readonly onStepFinishCb?: (event: StreamTurnStepFinish) => void;

  constructor(opts: StreamTurnDriverOptions) {
    this.turnId = opts.turnId;
    this.promptIndex = opts.promptIndex;
    this.modelId = opts.modelId;
    this.engine = opts.engine;
    this.harness = opts.harness;
    this.traceBaseMs = opts.traceBaseMs;
    this.spans = opts.spans;
    this.outcome = opts.outcome;
    this.onStepFinishCb = opts.onStepFinish;
  }

  get traceStarted(): boolean {
    return this.started;
  }

  get runSucceeded(): boolean {
    return this.succeeded;
  }

  /** Emit `turn_start`. Call at STREAM start (not function entry) so a
   *  pre-stream failure never creates a phantom turn. */
  emitTurnStart(writer: ChunkWriter): void {
    writeTraceEvent(writer, {
      type: "turn_start",
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      startedAtMs: this.traceBaseMs,
      ...(this.engine ? { engine: this.engine } : {}),
      ...(this.harness ? { harness: this.harness } : {}),
    });
    this.started = true;
  }

  /** Build the snapshot context for `emitTraceSnapshot`. Engines call
   *  `emitTraceSnapshot(writer, messages, tools, driver.snapshotContext(messages))`
   *  at their own cadence. */
  snapshotContext(messageHistory: ModelMessage[]): LiveTraceSnapshotTurnContext {
    return {
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
      turnSpans: this.spans,
      ...(this.usage ? { turnUsage: this.usage } : {}),
    };
  }

  /**
   * Fire the `onStepFinish` contract: cumulative `turnUsage`, a DEFENSIVE copy
   * of `turnSpans` (callers retain it across step boundaries), and
   * `settledWithError`. Wrapped so a throwing consumer can't crash the loop.
   */
  fireStepFinish(stepIndex: number, settledWithError: boolean): void {
    if (!this.onStepFinishCb) return;
    try {
      this.onStepFinishCb({
        stepIndex,
        promptIndex: this.promptIndex,
        ...(this.usage
          ? {
              turnUsage: {
                inputTokens: this.usage.inputTokens,
                outputTokens: this.usage.outputTokens,
                totalTokens: this.usage.totalTokens,
              },
            }
          : {}),
        settledWithError,
        turnSpans: [...this.spans],
      });
    } catch (error) {
      logger.warn("[stream-turn-driver] onStepFinish callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Settle the turn: write the engine-built `finishChunk` (each engine
   * constructs its own — `emitFinish` for harness, `createClientFinishChunk`
   * for emulated), then `turn_finish`, and mark success. The caller is
   * responsible for the silent-abort gate BEFORE calling this.
   */
  finishTurn(
    writer: ChunkWriter,
    opts: { finishChunk?: UIMessageChunk; alreadyEmittedFinish?: boolean }
  ): void {
    if (opts.finishChunk && !opts.alreadyEmittedFinish) {
      writer.write(opts.finishChunk);
    }
    writeTraceEvent(writer, {
      type: "turn_finish",
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      finishReason: this.finishReason,
      ...(this.usage ? { usage: this.usage } : {}),
    });
    this.succeeded = true;
  }

  /** Emit a final snapshot + `turn_finish` on a mid-stream FAILURE (parity
   *  across engines), guarded so a pre-stream failure stays phantom-free. The
   *  snapshot itself is emitted by the caller (engine-specific tools arg);
   *  this only writes `turn_finish`. */
  emitErrorTurnFinish(writer: ChunkWriter): void {
    if (!this.started) return;
    writeTraceEvent(writer, {
      type: "turn_finish",
      turnId: this.turnId,
      promptIndex: this.promptIndex,
      ...(this.usage ? { usage: this.usage } : {}),
    });
  }

  /**
   * Assemble the `PersistedTurnTrace` from the accumulated spans + usage, and
   * stamp how the turn ended.
   *
   * `unresolvedToolCalls` is supplied by the caller rather than derived here:
   * the driver never sees the message history, and the list has to be computed
   * from the SAME closure that decides what to write, or the record and the
   * transcript would disagree about which calls were left open.
   */
  buildPersistedTrace(opts?: {
    unresolvedToolCalls?: TurnOutcomeUnresolvedToolCall[];
  }): PersistedTurnTrace {
    return {
      turnId: this.turnId,
      startedAt: this.traceBaseMs,
      promptIndex: this.promptIndex,
      endedAt: Date.now(),
      spans: [...this.spans],
      ...(this.usage ? { usage: this.usage } : {}),
      finishReason: this.finishReason,
      modelId: this.modelId,
      ...(this.outcome
        ? { outcomeAtTurn: this.outcome.record(opts?.unresolvedToolCalls) }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Turn outcome builder
// ---------------------------------------------------------------------------

/**
 * The producer for `TurnOutcomeRecord` — Layer 2 of the turn-outcome contract.
 *
 * FUNCTION-SCOPED, not driver-scoped. The harness only constructs its
 * `StreamTurnDriver` once `agent.stream()` has resolved, so a turn aborted
 * during credential resolution, box wake or connect has no driver at all — and
 * those are exactly the endings that used to leave no evidence. The builder is
 * created at engine ENTRY and the engine marks against it whether or not a
 * driver exists; the driver merely stamps `builder.record()` onto the trace it
 * assembles.
 *
 * A STATE MACHINE, single-threaded within one engine call. States are
 * `running`, `paused`, and the terminal set. The transitions are not a detail —
 * they are how the two genuine races resolve:
 *
 * | From     | Mark                | Result                                  |
 * |----------|---------------------|-----------------------------------------|
 * | running  | any terminal        | that terminal                           |
 * | running  | paused              | paused                                  |
 * | paused   | failed, cancelled   | that terminal                           |
 * | paused   | completed, timed_out| ignored, appended to `superseded`       |
 * | terminal | anything            | ignored, appended to `superseded`, warn |
 *
 * `paused → failed` is the one that looks surprising and is the most important:
 * the harness approval pause commits its sidecar standalone, and if that commit
 * fails the lease is released and the pause is LOST. A record that still
 * claimed `paused` would promise a resume that can never happen.
 */
export interface TurnOutcomeBuilderOptions {
  engine: TurnRuntimeEngine;
  /** The harness HOST id. Kept even on the emulated engine — a scope step-up
   *  continuation runs emulated by design and must stay attributable. */
  harness?: string;
  modelAccess: TurnModelAccess;
  /**
   * What an abort means on THIS caller's signal when the reason carries no
   * typed source. The web request signal means the browser went away
   * (`client_disconnect`); a programmatic signal means its owner asked
   * (`caller`). Guessing would collapse the distinction this vocabulary exists
   * to keep.
   */
  defaultCancellationSource?: TurnCancellationSource;
  /** Injectable for tests; production leaves it alone. */
  now?: () => number;
}

type BuilderState = "running" | "paused" | "terminal";

/** The typed abort reason a supervised cancel raises, so the abort site can say
 *  WHO cancelled instead of leaving four causes as one boolean. */
export interface TurnCancellationReason extends Error {
  name: "AbortError";
  turnCancellationSource: TurnCancellationSource;
}

/**
 * Build the abort reason for a supervised cancel.
 *
 * `name: "AbortError"` because every catch site in both engines recognizes
 * exactly that string; a plain `Error` would fall through to the failure path
 * and file a lost lease as a crash.
 */
export function createCancellationReason(
  source: TurnCancellationSource,
  message: string,
): TurnCancellationReason {
  const error = new Error(message) as TurnCancellationReason;
  error.name = "AbortError";
  error.turnCancellationSource = source;
  return error;
}

/** Read the typed source off an abort reason (or anything wrapping one). */
export function turnCancellationSourceOf(
  reason: unknown,
): TurnCancellationSource | undefined {
  let current: unknown = reason;
  // Depth-capped and self-guarded like `shared/abort-errors.ts`: a `cause`
  // chain is caller-supplied and can be cyclic.
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") return undefined;
    const candidate = current as {
      turnCancellationSource?: unknown;
      cause?: unknown;
    };
    const source = candidate.turnCancellationSource;
    if (
      typeof source === "string" &&
      (TURN_CANCELLATION_SOURCES as readonly string[]).includes(source)
    ) {
      return source as TurnCancellationSource;
    }
    const cause: unknown = candidate.cause;
    if (cause === undefined || cause === current) return undefined;
    current = cause;
  }
  return undefined;
}

export class TurnOutcomeBuilder {
  private readonly engine: TurnRuntimeEngine;
  private readonly harness?: string;
  private readonly modelAccess: TurnModelAccess;
  private readonly defaultCancellationSource: TurnCancellationSource;
  private readonly now: () => number;

  private state: BuilderState = "running";
  private lifecycle: TurnLifecycle | undefined;
  private finishReason: string | undefined;
  private timeout: TimeoutMetadata | undefined;
  private cancellationSource: TurnCancellationSource | undefined;
  private errorSource: TurnErrorSource | undefined;
  private errorCode: string | undefined;
  private errorHttpStatus: number | undefined;
  private pauseKind: TurnPauseKind | undefined;
  private readonly superseded: Array<{ mark: TurnLifecycle; at: number }> = [];

  /**
   * Tool calls this turn actually DISPATCHED, in dispatch order, and which of
   * them settled. The pair is what makes `never_started` vs `outcome_unknown`
   * answerable at all.
   *
   * The NAMES are kept, not just the ids, because the builder is the only
   * witness for some of them. The harness flushes its assistant segment after
   * the stream settles, so a turn cancelled mid-stream has the tool call
   * NOWHERE in `messageHistory` — and a record derived from history alone would
   * report no unresolved calls for exactly the turn most likely to have left
   * one running inside somebody's sandbox.
   */
  private readonly dispatched = new Map<string, string>();
  private readonly settled = new Set<string>();

  constructor(opts: TurnOutcomeBuilderOptions) {
    this.engine = opts.engine;
    this.harness = opts.harness;
    this.modelAccess = opts.modelAccess;
    this.defaultCancellationSource = opts.defaultCancellationSource ?? "caller";
    this.now = opts.now ?? Date.now;
  }

  /** Tool EXECUTION began — the call was sent somewhere it could take effect. */
  markToolDispatched(toolCallId: string, toolName?: string): void {
    if (!toolCallId) return;
    // First writer wins on the name: a re-dispatch of the same id is the same
    // call, and the name it was first sent under is the one a reader will
    // recognize.
    if (!this.dispatched.has(toolCallId)) {
      this.dispatched.set(toolCallId, toolName || "unknown");
    }
  }

  /** A dispatched call produced a result (success or error — both are answers). */
  markToolSettled(toolCallId: string): void {
    if (toolCallId) this.settled.add(toolCallId);
  }

  /**
   * Was this call sent somewhere it might have taken effect?
   *
   * The conservative reading when the answer is unknown is `outcome_unknown`,
   * and the ONLY reason this engine can do better is that it watched the
   * dispatch itself.
   */
  unresolvedToolCallState(toolCallId: string): UnresolvedToolCallState {
    return this.dispatched.has(toolCallId) && !this.settled.has(toolCallId)
      ? "outcome_unknown"
      : "never_started";
  }

  /**
   * Calls this turn dispatched and never saw settle, in dispatch order.
   *
   * Merged into the record on top of whatever the caller derived from the
   * transcript — see the `dispatched` docblock for why the transcript is not
   * always enough.
   */
  dispatchedUnsettledToolCalls(): TurnOutcomeUnresolvedToolCall[] {
    const out: TurnOutcomeUnresolvedToolCall[] = [];
    for (const [toolCallId, toolName] of this.dispatched) {
      if (this.settled.has(toolCallId)) continue;
      out.push({ toolCallId, toolName, state: "outcome_unknown" });
    }
    return out;
  }

  markPaused(kind: TurnPauseKind): void {
    if (this.state !== "running") {
      this.supersede("paused");
      return;
    }
    this.state = "paused";
    this.lifecycle = "paused";
    this.pauseKind = kind;
  }

  markCompleted(finishReason?: string): void {
    // A pause is a real terminal for this turn's purposes; a stream that then
    // reports "finished" is describing the leg that paused, not a completion.
    if (!this.enterTerminal("completed", { alsoFromPaused: false })) return;
    this.finishReason = finishReason;
  }

  markCancelled(source: TurnCancellationSource): void {
    if (!this.enterTerminal("cancelled", { alsoFromPaused: true })) return;
    this.cancellationSource = source;
  }

  markTimedOut(timeout: TimeoutMetadata): void {
    if (!this.enterTerminal("timed_out", { alsoFromPaused: false })) return;
    this.timeout = timeout;
  }

  markFailed(args: {
    errorSource: TurnErrorSource;
    errorCode?: string;
    errorHttpStatus?: number;
  }): void {
    if (!this.enterTerminal("failed", { alsoFromPaused: true })) return;
    this.errorSource = args.errorSource;
    this.errorCode = args.errorCode;
    this.errorHttpStatus = args.errorHttpStatus;
  }

  /** The provider's own word, recorded independently of the lifecycle. */
  setFinishReason(finishReason: string | undefined): void {
    if (finishReason) this.finishReason = finishReason;
  }

  get settledLifecycle(): TurnLifecycle | undefined {
    return this.lifecycle;
  }

  /** True once a terminal mark landed — a pause does NOT count. */
  get isTerminal(): boolean {
    return this.state === "terminal";
  }

  /**
   * Assemble the record.
   *
   * With NO terminal mark at all this returns `failed` / `setup` /
   * `no_terminal_mark` and logs at error level. A record never defaults to
   * `completed`: an engine path that forgot to mark its ending is a bug, and
   * reporting it as success is how the original defect was invisible for so
   * long.
   */
  record(
    unresolvedToolCalls?: TurnOutcomeUnresolvedToolCall[],
  ): TurnOutcomeRecord {
    let lifecycle = this.lifecycle;
    let errorSource = this.errorSource;
    let errorCode = this.errorCode;
    if (lifecycle === undefined) {
      logger.error(
        "[turn-outcome] a turn ended with no terminal mark; recording it as failed",
        { engine: this.engine, ...(this.harness ? { harness: this.harness } : {}) },
      );
      lifecycle = "failed";
      errorSource = "setup";
      errorCode = "no_terminal_mark";
    }

    // The caller's transcript-derived list first (history order, which is what
    // a reader scrolls), then anything the builder witnessed that the
    // transcript does not carry. `undefined` means "do not list any" — a paused
    // turn, whose dangling call is the resume handle rather than a loose end.
    const mergedUnresolved: TurnOutcomeUnresolvedToolCall[] = [];
    if (unresolvedToolCalls !== undefined) {
      const seen = new Set<string>();
      for (const call of unresolvedToolCalls) {
        if (seen.has(call.toolCallId)) continue;
        seen.add(call.toolCallId);
        mergedUnresolved.push(call);
      }
      for (const call of this.dispatchedUnsettledToolCalls()) {
        if (seen.has(call.toolCallId)) continue;
        seen.add(call.toolCallId);
        mergedUnresolved.push(call);
      }
    }

    const termination = {
      ...(this.timeout ? { timeout: this.timeout } : {}),
      ...(this.cancellationSource
        ? { cancellationSource: this.cancellationSource }
        : {}),
      ...(errorSource ? { errorSource } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(this.errorHttpStatus !== undefined
        ? { errorHttpStatus: this.errorHttpStatus }
        : {}),
      ...(mergedUnresolved.length > 0
        ? { unresolvedToolCalls: mergedUnresolved }
        : {}),
      ...(this.superseded.length > 0 ? { superseded: [...this.superseded] } : {}),
    };
    // `completed` FORBIDS a termination (the contract's own invariant): a turn
    // cannot both have finished and have been ended by something. A superseded
    // late mark on a completed turn is diagnosis we drop rather than a claim we
    // make.
    const hasTermination =
      lifecycle !== "completed" && Object.keys(termination).length > 0;

    return {
      contractVersion: CURRENT_TURN_OUTCOME_CONTRACT_VERSION,
      lifecycle,
      runtime: {
        engine: this.engine,
        ...(this.harness ? { harness: this.harness } : {}),
        modelAccess: this.modelAccess,
      },
      ...(this.finishReason ? { finishReason: this.finishReason } : {}),
      ...(hasTermination ? { termination } : {}),
      ...(lifecycle === "paused" && this.pauseKind
        ? { paused: { kind: this.pauseKind } }
        : {}),
      recordedAt: this.now(),
    };
  }

  /** The default source for an abort with no typed reason on it. */
  cancellationSourceFor(reason: unknown): TurnCancellationSource {
    return turnCancellationSourceOf(reason) ?? this.defaultCancellationSource;
  }

  private enterTerminal(
    mark: TurnLifecycle,
    opts: { alsoFromPaused: boolean },
  ): boolean {
    if (this.state === "terminal") {
      this.supersede(mark);
      return false;
    }
    if (this.state === "paused" && !opts.alsoFromPaused) {
      this.supersede(mark);
      return false;
    }
    this.state = "terminal";
    this.lifecycle = mark;
    // A pause that later failed or was cancelled is no longer a pause.
    this.pauseKind = undefined;
    return true;
  }

  private supersede(mark: TurnLifecycle): void {
    // Bounded to the contract's cap so a pathological loop cannot make the
    // record unwritable; the first entries are the ones that explain the race.
    if (this.superseded.length < 32) {
      this.superseded.push({ mark, at: this.now() });
    }
    if (this.state === "terminal") {
      logger.warn("[turn-outcome] terminal mark ignored; turn already settled", {
        settled: this.lifecycle,
        ignored: mark,
        engine: this.engine,
      });
    }
  }
}

/**
 * Decide what a caught error MEANS, by evidence rather than by arrival order.
 *
 * The deadline-versus-error race has no reliable ordering: provider SDKs raise
 * a FRESH, unstamped `AbortError` when their request is aborted, so the caught
 * error carries none of the deadline's attribution. The signal's own `reason`
 * does, and `composeAbortSignals` propagates it through every composition — so
 * the reason is consulted BEFORE the caught error, and the caught error only as
 * a fallback for the paths that throw the deadline error directly.
 *
 * Order is deliberate: timeout, then cancellation, then failure. An aborted
 * signal whose reason names a clock is a timeout even if something else threw
 * first, because the budget expiring is what caused the throw.
 */
export function classifyCatch(
  builder: TurnOutcomeBuilder,
  args: {
    error: unknown;
    signal: AbortSignal | undefined;
    /** Whose failure this is if it is a failure — decided at the catch site
     *  from whether the model was ever invoked, never parsed from text. */
    errorSource: TurnErrorSource;
    errorCode?: string;
    errorHttpStatus?: number;
    /** Turn start, for the timeout's `elapsedMs`. */
    startedAtMs: number;
    now?: () => number;
  },
): TurnLifecycle {
  const aborted = args.signal?.aborted === true;
  if (aborted) {
    return classifyAbort(builder, {
      signal: args.signal,
      // Only consulted when the signal carries no reason of its own: the paths
      // that throw the deadline error directly rather than through a signal.
      fallbackReason: args.error,
      startedAtMs: args.startedAtMs,
      ...(args.now ? { now: args.now } : {}),
    });
  }
  builder.markFailed({
    errorSource: args.errorSource,
    ...(args.errorCode ? { errorCode: args.errorCode } : {}),
    ...(args.errorHttpStatus !== undefined
      ? { errorHttpStatus: args.errorHttpStatus }
      : {}),
  });
  return "failed";
}

/**
 * Mark an abort the engine OBSERVED rather than caught — the pre-start bail and
 * the between-steps gate, which `return` instead of throwing.
 *
 * Shared with `classifyCatch` because the question is the same one and getting
 * a different answer at the two kinds of site is exactly the bug: a turn whose
 * DEADLINE fired before its first step would otherwise be recorded as a user
 * cancellation, which reads as "somebody asked for this" and is never counted
 * as a failure.
 */
export function classifyAbort(
  builder: TurnOutcomeBuilder,
  args: {
    signal: AbortSignal | undefined;
    fallbackReason?: unknown;
    startedAtMs: number;
    now?: () => number;
  },
): TurnLifecycle {
  const now = args.now ?? Date.now;
  const reason = args.signal?.reason;
  const deadline =
    deadlineAttributionOf(reason) ?? deadlineAttributionOf(args.fallbackReason);
  if (deadline) {
    builder.markTimedOut({
      clock: deadline.clock,
      budgetMs: deadline.budgetMs,
      elapsedMs: Math.max(0, now() - args.startedAtMs),
    });
    return "timed_out";
  }
  builder.markCancelled(
    builder.cancellationSourceFor(reason ?? args.fallbackReason),
  );
  return "cancelled";
}

/** The clock AND budget named by a deadline abort, when it is one. */
function deadlineAttributionOf(
  value: unknown,
): { clock: DeadlineClock; budgetMs: number } | undefined {
  const clock = deadlineClockOf(value);
  if (!clock) return undefined;
  let current: unknown = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") break;
    const candidate = current as { budgetMs?: unknown; cause?: unknown };
    if (typeof candidate.budgetMs === "number") {
      return { clock, budgetMs: candidate.budgetMs };
    }
    const cause: unknown = candidate.cause;
    if (cause === undefined || cause === current) break;
    current = cause;
  }
  // The clock is the load-bearing half; a budget we could not read is recorded
  // as 0 rather than costing the record its timeout attribution.
  return { clock, budgetMs: 0 };
}
