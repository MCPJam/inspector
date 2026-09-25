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

/**
 * The termination legs that make NO claim about which ending occurred. Every
 * lifecycle that may carry a termination carries exactly these; the two legs
 * that DO name an ending live on their own variants below.
 */
const terminationCommonShape = {
  errorSource: turnErrorSourceZ.optional(),
  errorCode: z.string().min(1).max(256).optional(),
  errorHttpStatus: z.number().int().min(100).max(599).optional(),
  // Bounded: a pathological turn must not be able to make a trace row
  // unwritable. The cap is generous next to any real step's fan-out.
  unresolvedToolCalls: z.array(unresolvedToolCallZ).max(256).optional(),
  /**
   * Terminal marks that arrived after the turn had already settled, kept for
   * DIAGNOSIS rather than for policy. Deliberately NOT restricted per
   * lifecycle: a late mark is evidence ABOUT the race, not a second claim
   * about the ending, and is valid wherever a termination is.
   */
  superseded: z
    .array(
      z.strictObject({
        mark: turnLifecycleZ,
        at: z.number().int().nonnegative(),
      }),
    )
    .max(32)
    .optional(),
};

/** A termination on a lifecycle that names neither a clock nor a canceller. */
export const neutralTerminationZ = z.strictObject(terminationCommonShape);

/** A `timed_out` turn's termination: it MUST name the clock that fired. */
export const timedOutTerminationZ = z.strictObject({
  ...terminationCommonShape,
  timeout: timeoutMetadataZ,
});

/** A `cancelled` turn's termination: it MUST name who stopped it. */
export const cancelledTerminationZ = z.strictObject({
  ...terminationCommonShape,
  cancellationSource: turnCancellationSourceZ,
});

export const turnRuntimeZ = z.strictObject({
  engine: z.enum(TURN_RUNTIME_ENGINES),
  harness: z.string().min(1).max(128).optional(),
  modelAccess: z.enum(TURN_MODEL_ACCESS),
});

/**
 * THE RECORD, as a discriminated union on `lifecycle`.
 *
 * Every invariant this contract has is now STRUCTURAL rather than a refinement
 * that only runs at parse time, so a producer inside this repo cannot construct
 * a record that the parser would refuse — the compiler refuses it first. The
 * wire shape is unchanged: each variant is the same object, and which keys are
 * required is what differs.
 *
 * What each variant pins, and why:
 *
 * - `completed` carries NO `termination`. A turn cannot both have finished and
 *   have been ended by something.
 * - `timed_out` MUST carry `termination.timeout`. A timeout with no clock is
 *   the bare "aborted" this whole contract exists to replace.
 * - `cancelled` MUST carry `termination.cancellationSource`, so "cancelled"
 *   cannot collapse a user Stop, a lost lease and a lost reservation into one
 *   word.
 * - `paused` MUST carry `paused.kind`, because a pause naming no rail sends a
 *   reader to the wrong resume.
 * - and the INVERSE of each falls out of the variants being strict: a
 *   `timeout` on a `failed` record, or a `cancellationSource` on a `completed`
 *   one, is not a harmless extra. Every reader keys off `lifecycle`, so such a
 *   record would have one half answering "the turn ran out of time" and the
 *   other "it did not".
 *
 * `interrupted` has NO producer — it is the slot for a process that died
 * before writing anything, and a test says so.
 */
const outcomeCommonShape = {
  contractVersion: z.literal(CURRENT_TURN_OUTCOME_CONTRACT_VERSION),
  runtime: turnRuntimeZ,
  /** The provider's own word, kept separate from `lifecycle` on purpose. */
  finishReason: z.string().min(1).max(128).optional(),
  recordedAt: z.number().int().nonnegative(),
};

export const turnOutcomeRecordZ = z.discriminatedUnion("lifecycle", [
  z.strictObject({
    ...outcomeCommonShape,
    lifecycle: z.literal("completed"),
  }),
  z.strictObject({
    ...outcomeCommonShape,
    lifecycle: z.literal("failed"),
    termination: neutralTerminationZ.optional(),
  }),
  z.strictObject({
    ...outcomeCommonShape,
    lifecycle: z.literal("timed_out"),
    termination: timedOutTerminationZ,
  }),
  z.strictObject({
    ...outcomeCommonShape,
    lifecycle: z.literal("cancelled"),
    termination: cancelledTerminationZ,
  }),
  z.strictObject({
    ...outcomeCommonShape,
    lifecycle: z.literal("paused"),
    termination: neutralTerminationZ.optional(),
    paused: z.strictObject({ kind: turnPauseKindZ }),
  }),
  z.strictObject({
    ...outcomeCommonShape,
    lifecycle: z.literal("interrupted"),
    termination: neutralTerminationZ.optional(),
  }),
]);

/**
 * DERIVED from the schema, not declared beside it. The previous hand-written
 * type allowed `timed_out` with no timeout, `cancelled` with no source, and
 * `completed` carrying a termination: the refinements caught those at parse
 * time, but a producer returning this type got no compiler protection at all.
 */
export type TurnOutcomeRecord = z.infer<typeof turnOutcomeRecordZ>;

/** One row of `termination.unresolvedToolCalls`. */
export type TurnOutcomeUnresolvedToolCall = z.infer<typeof unresolvedToolCallZ>;

/** A termination block, whichever lifecycle it belongs to. */
export type TurnTermination = NonNullable<
  Extract<TurnOutcomeRecord, { lifecycle: "failed" }>["termination"]
>;

/**
 * A READ-ONLY projection of a termination for consumers that do not care which
 * lifecycle produced the record — every leg optional, DERIVED from the two
 * variants that carry a lifecycle-naming leg.
 *
 * Writers still go through the union, so this cannot be used to build an
 * invalid record; it only spares a reader from narrowing when it genuinely
 * wants "whatever this turn recorded". Narrowing on `lifecycle` remains the
 * only thing that PROVES a particular leg is present.
 */
export type TurnTerminationView = Partial<
  z.infer<typeof timedOutTerminationZ> & z.infer<typeof cancelledTerminationZ>
>;

/**
 * The record's termination, whichever variant it is, or `undefined`.
 *
 * Takes an OPTIONAL record because most readers hold one that way — a turn that
 * produced no record at all is the `unrecorded` case, not a failure.
 */
export function terminationOf(
  record: TurnOutcomeRecord | undefined,
): TurnTerminationView | undefined {
  if (!record) return undefined;
  return "termination" in record ? record.termination : undefined;
}

/** The rail a paused turn is waiting on, or `undefined` when it is not paused. */
export function pauseKindOf(
  record: TurnOutcomeRecord | undefined,
): TurnPauseKind | undefined {
  return record?.lifecycle === "paused" ? record.paused.kind : undefined;
}

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
