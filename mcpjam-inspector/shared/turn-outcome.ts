/**
 * How a turn ENDED — one record, read by every consumer.
 *
 * A turn that ends abnormally (Stop, a timeout, an error, a lost lease) used to
 * leave different evidence depending on which path ran it, and most paths left
 * none at all. The hosted facade hardcoded `aborted: false` while both engines
 * computed a real flag and threw it away; stopped turns were excluded from
 * persistence entirely, so tool calls that already ran and were already billed
 * left no durable trace; failure detection partly keyed on the ABSENCE of that
 * trace. Four consumers each carried their own private vocabulary for "how did
 * this end".
 *
 * This is the one record they now share. Three layers, of which this is the
 * first: ONE RECORD every consumer reads, TWO RUNTIMES (emulated, harness) that
 * each produce it their own way, and PER-CONSUMER POLICY for what to do with a
 * turn that did not finish. The runtimes are deliberately not forced into one
 * implementation — only into one output.
 *
 * WHY THIS LIVES HERE AND NOT IN THE SDK. The Inspector pins a PUBLISHED
 * `@mcpjam/sdk` and the backend cannot import it at all, so an SDK home would
 * make every later step wait on a publish for a type nothing external reads
 * yet. Promote to `sdk/src/contract/` when a v1 API returns it. The backend's
 * hand-mirror is `convex/lib/turnOutcome.ts`, pinned in `convex/lib/mirrors.json`.
 *
 * NAMED `TurnOutcomeRecord`, not `TurnOutcome`: that name is already taken by
 * the Codex bridge (`harness/codex-appserver/bridge/stream-translator.ts`).
 */
import { z } from "zod";

/**
 * What ended, in the reader's terms — never the provider's.
 *
 * `finishReason` stays a separate field precisely because these are different
 * questions: a provider's `"stop"` and a `lifecycle: "cancelled"` can both be
 * true of the same turn when the abort arrived after the stream settled.
 *
 * `interrupted` has NO PRODUCER today, on purpose. It is the slot for a turn
 * whose process died before it could write anything — which requires durable
 * checkpoints nothing writes yet (see S7). It is in the vocabulary so a later
 * producer does not have to re-version the contract, and the test suite asserts
 * that nothing emits it.
 */
export const TURN_LIFECYCLES = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "paused",
  "interrupted",
] as const;
export type TurnLifecycle = (typeof TURN_LIFECYCLES)[number];

/**
 * WHO cancelled. The harness collapsed four distinct causes into one boolean;
 * an operator reading "cancelled" could not tell a user pressing Stop from a
 * lease the runtime lost underneath them, which are different bugs.
 *
 * `caller` is an explicit `AbortSignal` handed in by a programmatic caller;
 * `client_disconnect` is the web request signal firing because the browser went
 * away. The three `*_lost` causes are the harness's own supervision aborting
 * the turn.
 */
export const TURN_CANCELLATION_SOURCES = [
  "caller",
  "client_disconnect",
  "lease_lost",
  "liveness_lost",
  "reservation_lost",
] as const;
export type TurnCancellationSource = (typeof TURN_CANCELLATION_SOURCES)[number];

/**
 * Why a turn stopped short of a terminal state and expects to be resumed.
 *
 * FOUR RAILS, because the engine has four. The first two were the only ones
 * this vocabulary named at first, and the loop's other two pauses fell through
 * to `completed` — a resumable turn recorded as a finished one, which is the
 * exact claim this contract exists to stop anything making.
 *
 *  - `tool_approval` — a human is being asked about a call.
 *  - `scope_step_up` — the caller needs a wider grant before the call can run.
 *  - `client_fulfilled` — a `ui_*` / `page_*` / app-alias call the BROWSER
 *    executes; the server cannot run it and is waiting for the result.
 *  - `tool_input_required` — a multi-round-trip (`input_required`) tool
 *    suspended to a durable continuation and expects another leg.
 */
export const TURN_PAUSE_KINDS = [
  "tool_approval",
  "scope_step_up",
  "client_fulfilled",
  "tool_input_required",
] as const;
export type TurnPauseKind = (typeof TURN_PAUSE_KINDS)[number];

/**
 * WHOSE failure. Decided at the CATCH SITE from what the code knows — whether
 * the model was ever invoked — and never parsed back out of an error string.
 * Mirrors `HostedEvalTurnOutcome` / `StepEngineOutcome`, which already made
 * this call the same way.
 */
export const TURN_ERROR_SOURCES = ["model", "setup"] as const;
export type TurnErrorSource = (typeof TURN_ERROR_SOURCES)[number];

/**
 * A tool call left without a result, in one of TWO states — never one.
 *
 * The distinction is the whole point. A call that was never dispatched did
 * nothing and can be closed with a clean conscience. A call that WAS dispatched
 * and lost its result may have taken effect on somebody's real system, and
 * saying so is the only honest thing the record can do. Collapsing them would
 * make the reassuring text a lie exactly when it matters.
 */
export const UNRESOLVED_TOOL_CALL_STATES = [
  "never_started",
  "outcome_unknown",
] as const;
export type UnresolvedToolCallState =
  (typeof UNRESOLVED_TOOL_CALL_STATES)[number];

/**
 * Which budget expired. MOVED HERE from `server/utils/run-supervisor/deadline.ts`
 * (which now re-exports it) because a persisted record cannot depend on a
 * server-only module: the backend mirror and the client both read this.
 *
 * These strings reach persisted outcomes, so they are a closed set, not free
 * text — a timeout outcome must name its clock, never a bare "aborted".
 */
export const DEADLINE_CLOCKS = [
  "run",
  "iteration",
  "session",
  "turn",
  "toolCall",
  "sandboxCapacity",
  "setup",
  "discovery",
] as const;
export type DeadlineClock = (typeof DEADLINE_CLOCKS)[number];

/** Persisted attribution for a budget that expired. */
export type TimeoutMetadata = {
  clock: DeadlineClock;
  budgetMs: number;
  elapsedMs: number;
};

/** Which engine ran the turn, and whose credentials paid for the model. */
export const TURN_RUNTIME_ENGINES = ["emulated", "harness"] as const;
export type TurnRuntimeEngine = (typeof TURN_RUNTIME_ENGINES)[number];

export const TURN_MODEL_ACCESS = ["hosted", "direct"] as const;
export type TurnModelAccess = (typeof TURN_MODEL_ACCESS)[number];

export const CURRENT_TURN_OUTCOME_CONTRACT_VERSION = 1 as const;

export type TurnOutcomeRecord = {
  contractVersion: 1;
  lifecycle: TurnLifecycle;
  runtime: {
    engine: TurnRuntimeEngine;
    /**
     * The harness HOST id, kept even when `engine` is `"emulated"`. A scope
     * step-up resume continues on the emulated engine by design, and a record
     * that dropped the host would make that turn indistinguishable from a plain
     * Playground turn on the same session.
     */
    harness?: string;
    modelAccess: TurnModelAccess;
  };
  /** The provider's own word, kept separate from `lifecycle` on purpose. */
  finishReason?: string;
  termination?: {
    timeout?: TimeoutMetadata;
    cancellationSource?: TurnCancellationSource;
    errorSource?: TurnErrorSource;
    errorCode?: string;
    errorHttpStatus?: number;
    unresolvedToolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      state: UnresolvedToolCallState;
    }>;
    /**
     * Terminal marks that arrived after the turn had already settled, kept for
     * DIAGNOSIS rather than for policy. Nothing reads these to decide anything;
     * they exist so "the deadline and the error both fired, which won?" is
     * answerable from the row instead of from a log grep.
     */
    superseded?: Array<{ mark: TurnLifecycle; at: number }>;
  };
  paused?: { kind: TurnPauseKind };
  recordedAt: number;
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const turnLifecycleZ = z.enum(TURN_LIFECYCLES);
export const turnCancellationSourceZ = z.enum(TURN_CANCELLATION_SOURCES);
export const turnPauseKindZ = z.enum(TURN_PAUSE_KINDS);
export const turnErrorSourceZ = z.enum(TURN_ERROR_SOURCES);
export const unresolvedToolCallStateZ = z.enum(UNRESOLVED_TOOL_CALL_STATES);
export const deadlineClockZ = z.enum(DEADLINE_CLOCKS);

export const timeoutMetadataZ = z.strictObject({
  clock: deadlineClockZ,
  budgetMs: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
});

export const unresolvedToolCallZ = z.strictObject({
  toolCallId: z.string().min(1).max(512),
  toolName: z.string().min(1).max(512),
  state: unresolvedToolCallStateZ,
});

export const turnTerminationZ = z.strictObject({
  timeout: timeoutMetadataZ.optional(),
  cancellationSource: turnCancellationSourceZ.optional(),
  errorSource: turnErrorSourceZ.optional(),
  errorCode: z.string().min(1).max(256).optional(),
  errorHttpStatus: z.number().int().min(100).max(599).optional(),
  // Bounded: a pathological turn must not be able to make a trace row
  // unwritable. The cap is generous next to any real step's fan-out.
  unresolvedToolCalls: z.array(unresolvedToolCallZ).max(256).optional(),
  superseded: z
    .array(
      z.strictObject({
        mark: turnLifecycleZ,
        at: z.number().int().nonnegative(),
      }),
    )
    .max(32)
    .optional(),
});

export const turnRuntimeZ = z.strictObject({
  engine: z.enum(TURN_RUNTIME_ENGINES),
  harness: z.string().min(1).max(128).optional(),
  modelAccess: z.enum(TURN_MODEL_ACCESS),
});

/**
 * The invariants, as refinements rather than as prose nobody runs.
 *
 * Each one exists because its absence would let a record make a claim it cannot
 * back: a `timed_out` with no clock is the bare "aborted" this whole contract
 * replaces; a `completed` carrying a `termination` is a turn claiming both that
 * it finished and that something ended it.
 */
export const turnOutcomeRecordZ = z
  .strictObject({
    contractVersion: z.literal(CURRENT_TURN_OUTCOME_CONTRACT_VERSION),
    lifecycle: turnLifecycleZ,
    runtime: turnRuntimeZ,
    finishReason: z.string().min(1).max(128).optional(),
    termination: turnTerminationZ.optional(),
    paused: z.strictObject({ kind: turnPauseKindZ }).optional(),
    recordedAt: z.number().int().nonnegative(),
  })
  .superRefine((record, ctx) => {
    if (record.lifecycle === "timed_out" && !record.termination?.timeout) {
      ctx.addIssue({
        code: "custom",
        path: ["termination", "timeout"],
        message: "timed_out requires termination.timeout naming its clock",
      });
    }
    if (
      record.lifecycle === "cancelled" &&
      !record.termination?.cancellationSource
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["termination", "cancellationSource"],
        message: "cancelled requires termination.cancellationSource",
      });
    }
    if (record.lifecycle === "paused" && !record.paused) {
      ctx.addIssue({
        code: "custom",
        path: ["paused"],
        message: "paused requires paused.kind",
      });
    }
    if (record.lifecycle === "completed" && record.termination) {
      ctx.addIssue({
        code: "custom",
        path: ["termination"],
        message: "completed forbids termination",
      });
    }
    // AND THE INVERSE, for each of the three fields that NAME a lifecycle.
    //
    // A `timeout` on a `failed` record, or a `cancellationSource` on a
    // `completed` one, is not a harmless extra: every reader here keys off
    // `lifecycle`, so a record carrying both would have one half answering
    // "the turn ran out of time" and the other "it did not". The producer
    // that emits one is asserting two different endings for the same turn,
    // and the parse is the only place that can refuse the claim.
    //
    // `termination.superseded` is deliberately NOT restricted this way — a
    // late mark arriving after the turn already settled is diagnosis about
    // the race, valid under every lifecycle.
    if (record.termination?.timeout && record.lifecycle !== "timed_out") {
      ctx.addIssue({
        code: "custom",
        path: ["termination", "timeout"],
        message: "termination.timeout is only valid on a timed_out turn",
      });
    }
    if (
      record.termination?.cancellationSource &&
      record.lifecycle !== "cancelled"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["termination", "cancellationSource"],
        message:
          "termination.cancellationSource is only valid on a cancelled turn",
      });
    }
    if (record.paused && record.lifecycle !== "paused") {
      ctx.addIssue({
        code: "custom",
        path: ["paused"],
        message: "paused is only valid on a paused turn",
      });
    }
  });

// ---------------------------------------------------------------------------
// Guards + readers
// ---------------------------------------------------------------------------

export function isTurnLifecycle(value: unknown): value is TurnLifecycle {
  return (
    typeof value === "string" &&
    (TURN_LIFECYCLES as readonly string[]).includes(value)
  );
}

export function isDeadlineClock(value: unknown): value is DeadlineClock {
  return (
    typeof value === "string" &&
    (DEADLINE_CLOCKS as readonly string[]).includes(value)
  );
}

/**
 * Lifecycles that mean the turn RAN AS FAR AS IT COULD and stopped for a reason
 * outside the model's control. Distinct from `didTurnFail` because a cancelled
 * turn is not a defect — a stopped turn is the product working.
 */
const TERMINAL_UNFINISHED: ReadonlySet<TurnLifecycle> = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);

/** Did this turn reach a clean end? */
export function didTurnComplete(
  outcome: Pick<TurnOutcomeRecord, "lifecycle"> | undefined,
): boolean {
  return outcome?.lifecycle === "completed";
}

/**
 * Is this a FAILURE — something a run should report as broken?
 *
 * `cancelled` is deliberately NOT a failure: somebody asked for it. `paused` is
 * not a failure either; it is a turn waiting to be resumed.
 */
export function didTurnFail(
  outcome: Pick<TurnOutcomeRecord, "lifecycle"> | undefined,
): boolean {
  return outcome?.lifecycle === "failed" || outcome?.lifecycle === "timed_out";
}

/** Did the turn end without finishing, for any reason? */
export function isTurnUnfinished(
  outcome: Pick<TurnOutcomeRecord, "lifecycle"> | undefined,
): boolean {
  return outcome ? TERMINAL_UNFINISHED.has(outcome.lifecycle) : false;
}

/**
 * Should this turn's transcript be persisted with its tool calls CLOSED?
 *
 * `paused` is excluded on purpose: a paused turn's dangling tool call IS the
 * resume handle, and closing it would destroy the thing the next request needs.
 */
export function needsToolCallClosure(
  outcome: Pick<TurnOutcomeRecord, "lifecycle"> | undefined,
): boolean {
  return (
    outcome?.lifecycle === "cancelled" ||
    outcome?.lifecycle === "failed" ||
    outcome?.lifecycle === "timed_out"
  );
}

/**
 * Parse a record off the wire or out of a stored row.
 *
 * Returns `undefined` rather than throwing: a record that fails to parse must
 * never cost a turn its transcript. The caller then reads "unrecorded", which
 * is the honest answer and is never rendered as success.
 */
export function parseTurnOutcomeRecord(
  raw: unknown,
): TurnOutcomeRecord | undefined {
  const parsed = turnOutcomeRecordZ.safeParse(raw);
  return parsed.success ? (parsed.data as TurnOutcomeRecord) : undefined;
}
