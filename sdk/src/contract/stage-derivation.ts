/**
 * Deriving a stage's state from one run — the output side of the user-value
 * chain vocabulary pinned in `./chain.ts`.
 *
 * `./chain.ts` deliberately stops at the enums ("pinning the derivation output
 * belongs to whoever writes the derivation"). This module is that derivation:
 * the row shape, the reason codes, and the pure function that turns one
 * iteration's authored case + captured evidence into six stage rows.
 *
 * `deriveStageResults` is PURE and deterministic — no Convex ctx, no network,
 * no LLM, no clock. Same input, same six rows, forever. The validators live at
 * the bottom of the file and the analyzer functions themselves never touch `z`,
 * so they stay trivially unit-testable (the arrangement `analyzeSession` uses
 * in `mcpjam-backend`'s `convex/lib/sessionReadiness.ts`).
 *
 * Three rules this module exists to enforce, none of which are negotiable:
 *
 *   1. **Non-vacuity.** A stage reaches `passed` only when at least one piece
 *      of eligible evidence was actually inspected. Zero evidence is
 *      `notMeasured`. This is the whole point: a chain derived from missing
 *      spans that quietly reads as green is worse than no chain at all.
 *   2. **`notReached` is derived from POSITION**, per `USER_VALUE_STAGES`
 *      order — but only over a stage that measured NOTHING. A stage after the
 *      first failure that has its own evidence keeps its own row: a run
 *      disproves "never ran" the moment it produces a verdict for that stage.
 *      The array is normative; this module never sorts it.
 *   3. **`evaluator` is never folded into another category.** A broken grader
 *      is not a server defect, and counting it as one poisons every rate
 *      derived from it.
 *
 * What this module deliberately does NOT do:
 *
 *   - It never GUESSES `failureCategory: "metadata"` from the deterministic
 *     evidence alone. That category means "tool names, descriptions or
 *     schemas misled the model", which is a judgement about intent that no
 *     span carries on its own. `categoryFor`'s `selection` branch below is
 *     reachable, but ONLY through `evidence.metadataAttribution` — a scored,
 *     evidence-carrying verdict from the D7 judge (attributed elsewhere:
 *     `metadata-attribution` second-pass). No deterministic span or predicate
 *     ever produces it.
 *   - It never enforces policy. A policy block is REPRESENTED here
 *     (`notMeasured` + `blockedByPolicy`); enforcing it belongs elsewhere.
 *   - It never reads `finishReason`. That field is advisory display only and
 *     must never feed a gate (see `EvalTraceSpan.finishReason`).
 */

import { z } from "zod";
import {
  USER_VALUE_STAGES,
  failureCategorySchema,
  stageStateSchema,
  userValueStageSchema,
  type FailureCategory,
  type IterationStatus,
  type StageState,
  type UserValueStage,
} from "./chain.js";

/**
 * Bump when the derivation SEMANTICS change — not when a type moves.
 *
 * Stored on every derivation this module returns so a rebuild can target stale
 * rows (`stageAnalyzerVersion < CURRENT`). A versioned analyzer whose version
 * is not persisted cannot be recomputed selectively, which is the entire
 * reason `sessionReadiness` stamps `READINESS_ANALYZER_VERSION` on every
 * record it writes.
 *
 * 6 (UVH-IN1): tool-call predicate results are routed to `selection` instead
 * of falling to `userValue` as `predicateFailed`. `STAGE_REASONS` does not
 * move — the routing re-uses `missingToolCall` and `unexpectedToolCall` — so
 * the backend mirror needs no re-pin for this bump. Rows derived under 5 are
 * identifiable as stale and can be recomputed selectively.
 *
 * 7 (UVH-IN7): an OBSERVED errored tool call makes `response` measurable even
 * on a case that authored nothing about tools. Before this, such a run had
 * every applicable stage green while its legacy verdict failed on exactly
 * that tool error — a disagreement the chain had no row to express. Re-uses
 * `toolError`, so again no mirror re-pin.
 *
 * 8 (UVH-IN2): a model-call-layer failure is attributed to `providerError`
 * instead of leaving the trial uncategorised. This one DOES move
 * `STAGE_REASONS`; the backend mirror already carries the member (UVH-BE1
 * shipped it deliberately ahead of this bump), so nothing quarantines.
 */
export const STAGE_ANALYZER_VERSION = 8;

/**
 * The 7 above, named — the first analyzer that can report an errored tool call
 * on a case which authored no tool expectation.
 *
 * A reader comparing a stored row against this can tell a chain that found
 * nothing wrong from one that had no row in which to say so, which is the
 * difference between an open question and a known, closable one. It lives
 * beside the history rather than beside the copy that reads it so that a
 * future bump is edited where the bump is already being written down.
 */
export const STAGE_ANALYZER_VERSION_EVIDENCE_TRIGGERED_RESPONSE = 7;

/**
 * Why a stage landed where it did.
 *
 * A closed vocabulary, for the same reason the states are: free-text reasons
 * cannot be aggregated, and "no evidence" versus "the executor emits no spans"
 * versus "an earlier stage failed" are three different operator actions.
 */
export const STAGE_REASONS = [
  // ── nothing could be measured ──
  /** The stage has no span category at all — nothing could ever be captured. */
  "noSpanChannel",
  /** A sink existed and captured nothing eligible for this stage. */
  "noEvidenceCaptured",
  /**
   * Extra tool calls were captured, but the turn did not report whether its
   * own match options tolerate them — so whether they are a failure is
   * unknowable here. Never `failed`: `maxExtraToolCalls` defaults to `null`
   * (extras reported, non-fatal), so guessing "failed" would report a
   * PASSING run as broken at `selection`.
   */
  "matchVerdictUnavailable",
  /** The iteration row carries no trace whatsoever. */
  "traceAbsent",
  /** A trace exists with messages but no span channel — a custom executor. */
  "executorEmitsNoSpans",
  /** A policy prevented the run. Never `failed`: a block is not a defect. */
  "blockedByPolicy",
  /** The grader itself failed, so the run says nothing about the server. */
  "evaluatorError",
  /**
   * The MODEL-CALL layer failed: a provider outage, an exhausted credit
   * balance, a rate limit, or one of our own spend guardrails.
   *
   * Broader than the name suggests, and deliberately so — what every case has
   * in common is that OUR side of the call broke, so the run says nothing
   * about the MCP server under test. Never `failed`: blaming the server for
   * our provider's bad day is the mis-attribution this reason exists to stop.
   */
  "providerError",
  /** The harness never got to the test (setup abort). */
  "setupAborted",
  /**
   * The run reached the configured server's host and initialize failed
   * there (attribution `theirs`, egress canary verified).
   */
  "connectFailed",
  /**
   * Initialize succeeded but tools/list failed on a reached server. A
   * completed initialize is itself the egress evidence.
   */
  "toolsListFailed",
  /**
   * A connection/discovery failure without positive evidence our own
   * egress works. Never `connection: failed`.
   */
  "egressUnverified",
  /** The run was stopped mid-flight (cancel / timeout). */
  "lifecycleStopped",
  // ── the stage does not apply ──
  /** The authored case asserts nothing that this stage could decide. */
  "notAuthored",
  // ── position ──
  /** An earlier stage failed, so this one never ran. */
  "earlierStageFailed",
  // ── measured failures ──
  "missingToolCall",
  "unexpectedToolCall",
  "argumentMismatch",
  /** A domain error reported the protocol-correct way (`isError: true`). */
  "toolError",
  /** The call never produced a result (JSON-RPC / transport failure). */
  "protocolError",
  "renderFailed",
  "predicateFailed",
  // ── measured passes ──
  /** Positive evidence was inspected and the stage held. */
  "observed",
  /** No span proves it directly; a later stage's success implies it. */
  "impliedByLaterEvidence",
  // ── advisory judge (tier 2: consulted only where deterministic
  //    evidence is silent — see `deriveUserValue`) ──
  /** The judge scored at or above the threshold. */
  "judgeObserved",
  /** The judge scored inside the partial band (>= partialFloor, < threshold). */
  "judgePartial",
  /** The judge scored below the partial floor. */
  "judgeFailed",
  /** A verdict was owed and has not arrived yet. */
  "judgePending",
  /** No verdict was ever owed for this iteration. */
  "judgeNotRequested",
] as const;
export type StageReason = (typeof STAGE_REASONS)[number];

/** Pointers back at the evidence a row was decided from. */
export type StageEvidenceRefs = {
  spanIds?: string[];
  promptIndexes?: number[];
  predicateReasons?: string[];
};

/** One stage's verdict for one iteration. */
export type StageResultRow = {
  stage: UserValueStage;
  state: StageState;
  reason?: StageReason;
  evidence?: StageEvidenceRefs;
};

/** The full derivation for one iteration. */
export type StageDerivation = {
  /** ALWAYS six rows, in `USER_VALUE_STAGES` order. Never sorted. */
  stageResults: StageResultRow[];
  /** The FIRST failed stage, in chain order. Absent when nothing failed. */
  firstFailedStage?: UserValueStage;
  /**
   * The bucket this iteration is grouped under.
   *
   * CONTRACT, and it matters to anyone aggregating these: this field is
   * "why there is no good outcome", NOT "which stage failed". It can be
   * present with `firstFailedStage` ABSENT — a setup abort is
   * `failureCategory: "setup"` with all six rows `notMeasured`, and an
   * evaluator error is `failureCategory: "evaluator"` the same way. Both are
   * real answers and both would be lost by omitting the category. A rate that
   * wants only measured server failures must therefore filter on
   * `firstFailedStage`, not on the presence of this field. Pinned by test.
   */
  failureCategory?: FailureCategory;
  stageAnalyzerVersion: number;
};

// ── inputs ───────────────────────────────────────────────────────────────────
//
// Structural, minimal shapes rather than imports of the runner/reporting types:
// this module is consumed from the SDK, the inspector server and the client
// bundle, and a structural input keeps all three free of a shared runtime dep.
// `EvalTraceSpan` / `EvalTraceSpanInput` / `PromptTraceSummary` /
// `PredicateResult` all satisfy these by construction.

export type StageSpanLike = {
  id?: string;
  category?: string;
  status?: string;
  toolName?: string;
  promptIndex?: number;
  mcpErrorCode?: number;
};

export type StagePromptSummaryLike = {
  promptIndex?: number;
  expectedToolCalls?: readonly unknown[];
  missing?: readonly unknown[];
  unexpected?: readonly unknown[];
  argumentMismatches?: readonly unknown[];
  /**
   * The turn's OWN verdict, under the match options the case authored.
   *
   * Load-bearing, and the reason this field exists: `unexpected` is populated
   * whenever an actual call went unmatched, but `maxExtraToolCalls` defaults to
   * `null` — extras are REPORTED and non-fatal (`evaluateToolCalls`). Deciding
   * `selection` from the raw field therefore reports `failed` for a run whose
   * verdict is `passed`, which is the common shape of an agentic multi-turn
   * case (a search call before the expected one). The turn already knows the
   * answer; this analyzer must not re-derive it.
   */
  passed?: boolean;
};

export type StagePredicateResultLike = {
  passed?: boolean;
  reason?: string;
  /**
   * The predicate that produced this row, when the producer kept it.
   *
   * Optional because it is genuinely absent on older rows and on producers
   * that never carried it. A row without it is graded exactly as before —
   * user-value evidence — so widening this type changes nothing on its own.
   */
  predicate?: { type?: string; toolName?: string };
};

/**
 * Predicate kinds that are evidence about TOOL SELECTION, not user value.
 *
 * `stepsToPromptTurns` promotes only `toolCalledWith` into `expectedToolCalls`,
 * where the selection matcher grades it. The three kinds below fall through to
 * per-turn checks and arrive here as predicate results, so before UVH-IN1 a
 * case asserting "tool X was never called" filed its failure at `userValue`
 * with `predicateFailed` — the chain reporting that the user did not get what
 * they wanted, when what actually happened is that the model picked the wrong
 * tool. In one prod audit that alone accounted for the gap between 2 selection
 * failures and 12 user-value ones.
 *
 * `toolCalledWith` is deliberately absent: it is already matcher-graded, and
 * re-reading its point-in-time predicate row here would let a raw residual
 * contradict the adjudicated verdict the matcher path produces.
 */
const SELECTION_PREDICATE_REASONS: Record<string, StageReason> = {
  /** A required call never happened — the same fact `missing` reports. */
  toolCalledAtLeastOnce: "missingToolCall",
  /** Something else went first: a call we did not expect, in that position. */
  firstToolWas: "unexpectedToolCall",
  /** A forbidden tool was called. */
  toolNeverCalled: "unexpectedToolCall",
};

/**
 * Kinds that assert a call WILL happen, so they make `call` applicable.
 *
 * `toolNeverCalled` is deliberately excluded: a case whose only tool assertion
 * is "never call X" expects no call at all, and turning `call` on for it would
 * demand evidence of something the case exists to forbid.
 */
const POSITIVE_TOOL_CALL_PREDICATE_KINDS = new Set([
  "toolCalledAtLeastOnce",
  "firstToolWas",
]);

/** True when this predicate row is selection evidence rather than user value. */
export function isSelectionPredicateKind(kind: string | undefined): boolean {
  return kind !== undefined && kind in SELECTION_PREDICATE_REASONS;
}

/** True when this predicate kind asserts that a tool call will occur. */
export function isPositiveToolCallPredicateKind(
  kind: string | undefined
): boolean {
  return kind !== undefined && POSITIVE_TOOL_CALL_PREDICATE_KINDS.has(kind);
}

export type StageToolErrorLike = {
  kind?: string;
  toolName?: string;
};

/**
 * The layer a fatal step error came from, reported by the catch site.
 *
 * `deriveStageResults` reads only `source`; `code` and `httpStatus` ride along
 * as diagnostics for a reader, and are deliberately NOT part of the
 * classification — a rule keyed on a provider's status codes would be one
 * provider away from mis-attributing a whole class of run.
 */
export type StageStepErrorLike = {
  source?: "model" | "setup";
  code?: string;
  httpStatus?: number;
};

export type StageRenderObservationLike = {
  status?: string;
};

/**
 * The authored case — what makes `notApplicable` derivable.
 *
 * Without this the analyzer cannot tell "this stage does not apply to this
 * case" from "this stage was not measured", and every inapplicable stage would
 * be reported as an evidence gap. Authors never toggle stages: every field
 * here is INFERRED from what the case already declares.
 */
export type StageAuthoredCase = {
  /**
   * `model_free` ⇒ no model ever chooses a tool ⇒ `selection` does not apply.
   * Inferred from the authored steps/turns (a case with no `prompt` step),
   * never authored directly.
   */
  mode: "model_driven" | "model_free";
  isNegativeTest?: boolean;
  /** The case authored at least one expected tool call. */
  expectsToolCall?: boolean;
  /** The case asserts something about a rendered widget. */
  expectsWidgetRender?: boolean;
  /** Count of authored user-value assertions (predicates, expectedOutput). */
  assertionCount?: number;
  /**
   * A real user ask exists in this session/case — someone wanted something.
   *
   * D8. Eval cases derive `userValue` applicability from `assertionCount`
   * alone, which is right for an authored case: the assertions ARE the ask.
   * A chat session has an ask with no assertions attached to it, and the two
   * possible answers are not the same claim:
   *
   *   - ask present, no user-value grader ⇒ `userValue: notMeasured`. Someone
   *     wanted something and nothing here can say whether they got it.
   *   - no ask at all ⇒ `userValue: notApplicable`. There is nothing to
   *     satisfy, so there is no gap to close.
   *
   * Absent (the eval default) leaves the pre-D8 behaviour byte-identical.
   */
  hasUserAsk?: boolean;
  /**
   * What the ask says about whether a tool SHOULD have been called.
   *
   *   - `required`     — a call is part of the assertion (equivalent to
   *                      `expectsToolCall: true`, and it composes with it).
   *   - `not_required` — nothing here expects a call; `call` applicability
   *                      falls back to the authored signals alone.
   *   - `open`         — a real chat ask, where whether a tool was needed is
   *                      genuinely unknown. `call`/`response` become
   *                      applicable so observed spans can decide them, and
   *                      `selection` can NEVER be `passed` off a bare call:
   *                      that a tool ran is not evidence the RIGHT tool ran.
   *
   * Absent (the eval default) leaves the pre-D8 behaviour byte-identical.
   */
  toolExpectation?: "required" | "not_required" | "open";
};

/**
 * One run-level setup phase (connect or tools/list), folded across every
 * configured target. Connect and tools-list happen once per run above the
 * iteration boundary, so this is the derivation input — not spans.
 */
export type StageSetupPhaseSignal = {
  outcome: "ok" | "failed";
  /** Present on a failure only. */
  attribution?: "ours" | "theirs" | "unknown";
  /** Positive canary evidence that our own egress works. */
  egressVerified?: boolean;
  /** Culprit synthetic-span ids (`run-connect-<id>` / `run-toolslist-<id>`). */
  spanIds?: string[];
  /**
   * How long this setup PHASE took, in milliseconds — its wall-clock envelope.
   *
   * A RUN-LEVEL fact that happens to be copied onto every iteration so the
   * derivation above can read it per-iteration. Analytics must count it ONCE
   * per run+phase: a run with 200 trials copies one 3-second connect onto all
   * 200 of them, and a consumer that treats each copy as a sample reports a
   * 3-second connection latency measured 200 times.
   *
   * Deliberately NOT a source of per-trial `connection` / `discovery` latency —
   * see `STAGE_LATENCY_ELIGIBLE_STAGES` in `./stage-measurements.ts`. This
   * field is inert to `deriveStageResults`, which never reads it: timing must
   * not move a stage's state.
   */
  durationMs?: number;
};

export type StageSetupSignals = {
  connection?: StageSetupPhaseSignal;
  discovery?: StageSetupPhaseSignal;
};

/** Everything the run actually captured. */
export type StageEvidence = {
  spans?: readonly StageSpanLike[];
  /**
   * True when a trace object EXISTS but carries no span channel — the
   * caller-supplied `HostExecutor` case. Distinct from `spans: []`, and the
   * difference is the difference between "we looked and saw nothing happen"
   * and "this executor never reports what happened".
   */
  traceLacksSpanChannel?: boolean;
  /** True when the iteration carries no trace at all. */
  traceAbsent?: boolean;
  prompts?: readonly StagePromptSummaryLike[];
  predicateResults?: readonly StagePredicateResultLike[];
  toolErrors?: readonly StageToolErrorLike[];
  /**
   * The fatal step error's LAYER, when one was raised and the runner knew it.
   *
   * Distinct from `toolErrors`, which are the server's answers. This is our
   * own side breaking, and it is the difference between "the server gave us
   * bad data" and "we never got to ask".
   */
  stepError?: StageStepErrorLike;
  renderObservations?: readonly StageRenderObservationLike[];
  /** `tools_total_before` / `tools_exposed` — the one direct discovery signal. */
  toolSignals?: { toolsTotalBefore?: number; toolsExposed?: number };
  /**
   * Structured connect / tools-list evidence, threaded per-iteration
   * (precedent: `toolSignals`). Synthetic `connection`/`discovery` spans
   * are persistence/timeline-only and never enter this field.
   */
  setupSignals?: StageSetupSignals;
  /** The grader threw. Never folded into a server-side category. */
  evaluatorErrored?: boolean;
  /**
   * Advisory judge evidence for this iteration. TIER 2: consulted only where
   * deterministic evidence is silent. Never overturns a predicate failure.
   */
  judgeEvidence?: {
    status: "scored" | "error" | "skipped" | "not_applicable" | "pending";
    /**
     * `pending` only: was a verdict ever actually owed? Drives the
     * `judgePending` vs `judgeNotRequested` split.
     */
    pendingKind?: "scheduled" | "not_requested";
    verdict?: "pass" | "partial" | "fail";
    /** Bounded by the EXISTING evidence caps, same as predicate reasons. */
    reasons?: readonly string[];
  };
  /**
   * D7's advisory judge: did the server's OWN tool metadata (names,
   * descriptions, schemas) mislead the model into a wrong or missing tool
   * choice? Same tier-2 shape as `judgeEvidence` — a report-only LLM
   * round trip consulted only where `selection` already failed
   * deterministically (`missingToolCall` / `unexpectedToolCall`).
   *
   * Answers a BINARY attribution question, not a graded band: there is no
   * `judgeEvidence`-style `verdict` scale here, because "did the metadata
   * cause this?" has no meaningful partial answer the way "did the user get
   * what they wanted?" does.
   */
  metadataAttribution?: {
    status: "scored" | "error" | "skipped" | "not_applicable" | "pending";
    /** `pending` only, same split as `judgeEvidence.pendingKind`. */
    pendingKind?: "scheduled" | "not_requested";
    /** `true` ⇒ the judge concluded the server's tool metadata caused the miss. */
    attributed?: boolean;
    /**
     * Quoted evidence (description text vs. the ask) plus a one-line
     * rationale. Bounded by the EXISTING evidence caps, same as predicate
     * and judge reasons.
     */
    reasons?: readonly string[];
  };
};

export type StageDerivationInput = {
  authored: StageAuthoredCase;
  evidence: StageEvidence;
  iteration: { status: IterationStatus; error?: string };
  /** D1 only REPRESENTS a policy block; enforcing one is a different step. */
  policy?: { blocked: boolean; reason?: string };
};

// ── helpers (pure, no `z`) ───────────────────────────────────────────────────

/**
 * MCP-SDK-local codes. `-32000` (connection closed) and `-32001` (request
 * timeout) are CLIENT-side transport/lifecycle conditions, not server faults,
 * and cannot be distinguished from a server fault by code alone. A failure
 * carrying only these is attributed to `setup`, never to `serverData`.
 */
const TRANSPORT_LOCAL_MCP_CODES = new Set([-32000, -32001]);

/**
 * Evidence bounds.
 *
 * A predicate `reason` is a judge rationale — graded CONTENT, of no fixed
 * length, already stored once under `metadata.predicates`. Copying it whole
 * into a second key doubles what the row retains and hands the redaction
 * contract a second place to reach. Bounded here, at the producer, so the
 * bound holds on every path rather than only where a validator happens to run.
 */
export const MAX_EVIDENCE_REASONS = 5;
export const MAX_EVIDENCE_REASON_CHARS = 500;

const isToolSpan = (s: StageSpanLike) => s.category === "tool";
const spanFailed = (s: StageSpanLike) =>
  s.status === "error" || typeof s.mcpErrorCode === "number";

const nonEmpty = (v: readonly unknown[] | undefined) => (v?.length ?? 0) > 0;

const spanIds = (spans: readonly StageSpanLike[]): string[] =>
  spans.map((s) => s.id).filter((id): id is string => typeof id === "string");

const row = (
  stage: UserValueStage,
  state: StageState,
  reason?: StageReason,
  evidence?: StageEvidenceRefs
): StageResultRow => ({
  stage,
  state,
  ...(reason ? { reason } : {}),
  ...(evidence && Object.keys(evidence).length > 0 ? { evidence } : {}),
});

/**
 * Iteration statuses that mean "no verdict was ever produced".
 *
 * NOTE on reachability: a cancelled inspector iteration finalizes on a path
 * that builds no stage metadata at all, and `setup_failed` normally reaches the
 * setup-abort branch below, which can still name whose side broke. This set is
 * the floor for everything else: a caller that CAN spell a stopped status must
 * not have it mis-attributed to a server failure.
 */
const LIFECYCLE_STOPPED: ReadonlySet<IterationStatus> =
  new Set<IterationStatus>([
    "cancelled",
    "timed_out",
    "setup_failed",
    "skipped",
  ]);

/**
 * Which stages this case can say anything about at all.
 *
 * Computed before any evidence is INTERPRETED, so an inapplicable stage can
 * never be reported as an evidence gap. One entry (`response`) additionally
 * reads a single positive observation — see `hasObservedToolFailure`.
 */
/**
 * Did a tool call come back an ERROR the server is answerable for?
 *
 * Deliberately the exact condition `deriveResponse` decides `toolError` on —
 * a content error, or an errored span carrying no MCP error code (a domain
 * error reported the protocol-correct way). Written as one predicate used by
 * both so applicability and the deriver cannot drift into a state where a
 * stage is switched on by one rule and then found empty by the other.
 *
 * Transport-local failures are excluded by that same shared condition: a span
 * with an `mcpErrorCode` never reached the server's handler, so it is a setup
 * fact, not the server's answer.
 */
function hasObservedToolFailure(e: StageEvidence): boolean {
  const contentErrors = (e.toolErrors ?? []).some(
    (t) => t.kind === "content-error"
  );
  const domainFailed = (e.spans ?? []).some(
    (s) => isToolSpan(s) && spanFailed(s) && typeof s.mcpErrorCode !== "number"
  );
  return contentErrors || domainFailed;
}

function applicability(
  authored: StageAuthoredCase,
  evidence: StageEvidence
): Record<UserValueStage, boolean> {
  // A case that expects no tool call but IS a negative case still exercises
  // `call`: proving no call happened is the assertion.
  //
  // D8: an `open` tool expectation ALSO turns `call` on. A real chat ask has
  // no authored expectation to read, but the spans it produced can still say
  // whether a call was made and whether it worked — and a stage whose evidence
  // we are about to inspect must not be pre-declared inapplicable. `open` with
  // no call observed stays `notMeasured` (deriveCall's floor), which is the
  // honest answer: we do not know whether one was needed.
  const callApplies =
    authored.expectsToolCall === true ||
    authored.isNegativeTest === true ||
    authored.toolExpectation === "required" ||
    authored.toolExpectation === "open";
  return {
    // Every run must reach a server and read its tools, whatever it asserts.
    connection: true,
    discovery: true,
    selection: authored.mode === "model_driven",
    call: callApplies,
    // A case asserting a rendered widget has something for `response` to decide
    // even when it authors no expected tool call — `deriveResponse` reads the
    // render observations directly. Gating this on `callApplies` alone would
    // make `renderFailed` unreachable for a pure render probe.
    //
    // UVH-IN7: an OBSERVED errored tool call does the same. A case can author
    // nothing about tools — only predicates over the transcript — and still
    // have a tool fail on the server during the run. `notApplicable` there
    // says "this case has nothing for `response` to decide", which is false
    // the moment a call came back an error, and it is how the chain ended up
    // unable to represent a class of run whose legacy verdict failed on
    // exactly that tool error: every applicable stage green, the verdict red,
    // and no stage able to say why.
    //
    // This is the ONE evidence-driven entry in this table, and it is a
    // POSITIVE observation rather than a gap — which is what keeps the rule
    // above intact. A stage turned on by observed evidence cannot then be
    // reported as an evidence gap: `deriveResponse` has the very span that
    // turned it on.
    response:
      callApplies ||
      authored.expectsWidgetRender === true ||
      hasObservedToolFailure(evidence),
    // D8: a real ask makes `userValue` applicable even with nothing authored
    // to grade it. `notApplicable` would say "there was nothing to satisfy",
    // which is false the moment someone asked for something.
    userValue:
      (authored.assertionCount ?? 0) > 0 ||
      authored.expectsWidgetRender === true ||
      authored.hasUserAsk === true,
  };
}

// ── per-stage evaluators ─────────────────────────────────────────────────────

function nonTransportLocalToolSpans(e: StageEvidence): StageSpanLike[] {
  return (e.spans ?? []).filter(
    (s) =>
      isToolSpan(s) &&
      !(
        typeof s.mcpErrorCode === "number" &&
        TRANSPORT_LOCAL_MCP_CODES.has(s.mcpErrorCode)
      )
  );
}

function signalEvidence(signal: StageSetupPhaseSignal): StageEvidenceRefs {
  return signal.spanIds?.length ? { spanIds: signal.spanIds.slice(0, 5) } : {};
}

function deriveConnection(e: StageEvidence): StageResultRow {
  const signal = e.setupSignals?.connection;
  // (1) Structured signal says every expected target connected.
  if (signal?.outcome === "ok") {
    return row("connection", "passed", "observed", signalEvidence(signal));
  }
  // (2) A tool span that is not a transport-local failure proves we reached
  // the server. Measured later evidence outranks a contradictory classification.
  const reached = nonTransportLocalToolSpans(e);
  if (reached.length > 0) {
    return row("connection", "passed", "impliedByLaterEvidence", {
      spanIds: spanIds(reached).slice(0, 5),
    });
  }
  // (3) A tools-list count is the same retroactive proof.
  if ((e.toolSignals?.toolsTotalBefore ?? 0) > 0) {
    return row("connection", "passed", "impliedByLaterEvidence");
  }
  if (signal?.outcome === "failed") {
    const refs = signalEvidence(signal);
    // (4) Theirs + positive canary ⇒ the only honest `connection: failed`.
    if (signal.attribution === "theirs" && signal.egressVerified === true) {
      return row("connection", "failed", "connectFailed", refs);
    }
    // (5) Theirs without a canary, or (6) unknown: we cannot name their server.
    if (
      signal.attribution === "theirs" ||
      signal.attribution === "unknown" ||
      signal.attribution === undefined
    ) {
      return row("connection", "notMeasured", "egressUnverified", refs);
    }
    // (7) Ours (DNS, blocked egress, 401/403, transport-local MCP codes).
    return row("connection", "notMeasured", "setupAborted", refs);
  }
  // (8)
  if (e.traceAbsent) return row("connection", "notMeasured", "traceAbsent");
  // (9) v2 fallthrough. `noSpanChannel` stays in the vocabulary (old
  // producers still emit it) but this analyzer no longer does.
  return row("connection", "notMeasured", "noEvidenceCaptured");
}

function connectionPositivelyReached(e: StageEvidence): boolean {
  if (e.setupSignals?.connection?.outcome === "ok") return true;
  if ((e.toolSignals?.toolsTotalBefore ?? 0) > 0) return true;
  if (nonTransportLocalToolSpans(e).length > 0) return true;
  // A discovery *signal* is not enough: foldPhase emits one for an
  // unobserved target too. Only a completed initialize (connection ok)
  // or later tool evidence proves we reached their host.
  return false;
}

function deriveDiscovery(e: StageEvidence): StageResultRow {
  const signal = e.setupSignals?.discovery;
  if (signal?.outcome === "ok") {
    return row("discovery", "passed", "observed", signalEvidence(signal));
  }
  if ((e.toolSignals?.toolsTotalBefore ?? 0) > 0) {
    return row("discovery", "passed", "observed");
  }
  const tools = (e.spans ?? []).filter(isToolSpan);
  if (tools.length > 0) {
    return row("discovery", "passed", "impliedByLaterEvidence", {
      spanIds: spanIds(tools).slice(0, 5),
    });
  }
  if (signal?.outcome === "failed") {
    const refs = signalEvidence(signal);
    // Failed + initialize completed + theirs ⇒ measured discovery miss.
    // A completed initialize is the egress evidence; no canary needed.
    // Unknown (unobserved tools/list) stays notMeasured — incomplete
    // observation is not a server failure.
    if (connectionPositivelyReached(e) && signal.attribution === "theirs") {
      return row("discovery", "failed", "toolsListFailed", refs);
    }
    if (signal.attribution === "ours") {
      return row("discovery", "notMeasured", "setupAborted", refs);
    }
    return row("discovery", "notMeasured", "egressUnverified", refs);
  }
  if (e.traceAbsent) return row("discovery", "notMeasured", "traceAbsent");
  return row("discovery", "notMeasured", "noEvidenceCaptured");
}

const promptIndexes = (prompts: readonly StagePromptSummaryLike[]): number[] =>
  prompts
    .map((p) => p.promptIndex)
    .filter((i): i is number => typeof i === "number");

/**
 * D8 guard: a bare tool call is not evidence the RIGHT tool was chosen.
 *
 * `deriveSelection`'s pre-D8 floor for a turn summary with no `missing` and no
 * `unexpected` is `passed/observed` — correct for an AUTHORED case, where the
 * summary is the verdict of a comparison against declared expectations. A chat
 * session declares none: its turn summaries (if a caller ever supplies any)
 * compare against nothing, so "no missing calls" is vacuous rather than a pass.
 *
 * Under `toolExpectation: "open"` a `passed` selection therefore requires at
 * least one turn that actually declared expected calls. Everything else
 * degrades to `notMeasured` — never to `failed`, which would invent a defect
 * out of the same silence.
 */
function selectionNeedsExplicitEvidence(
  authored: StageAuthoredCase,
  prompts: readonly StagePromptSummaryLike[]
): boolean {
  if (authored.toolExpectation !== "open") return false;
  return !prompts.some((p) => nonEmpty(p.expectedToolCalls));
}

/** Tool-selection predicate rows, in author order. */
function selectionPredicates(e: StageEvidence): StagePredicateResultLike[] {
  return (e.predicateResults ?? []).filter((r) =>
    isSelectionPredicateKind(r.predicate?.type)
  );
}

/**
 * The reason a set of failed selection predicates is filed under.
 *
 * A missing REQUIRED call outranks an unexpected one: "the tool you needed was
 * never called" is the more specific and more actionable of the two, and a case
 * can fail both at once (a required call absent while a forbidden one fired).
 */
function selectionPredicateReason(
  failed: readonly StagePredicateResultLike[]
): StageReason {
  return failed.some(
    (r) =>
      SELECTION_PREDICATE_REASONS[r.predicate?.type ?? ""] === "missingToolCall"
  )
    ? "missingToolCall"
    : "unexpectedToolCall";
}

function deriveSelection(
  e: StageEvidence,
  authored: StageAuthoredCase
): StageResultRow {
  const prompts = e.prompts ?? [];
  const predicates = selectionPredicates(e);
  // Authored tool-call predicates ARE explicit evidence about selection, so a
  // case carrying them is never sent down the "nothing adjudicates this" path
  // below even when it authored no `expectedToolCalls`.
  if (
    predicates.length === 0 &&
    selectionNeedsExplicitEvidence(authored, prompts)
  ) {
    // No trace at all outranks both branches below, the same way it does in
    // `deriveCall` and `deriveResponse`. "The run recorded no trace" and "a
    // sink existed and captured nothing" are different facts, and reporting
    // the second for the first tells an operator to go looking at an empty
    // channel that was never written.
    if (e.traceAbsent) return row("selection", "notMeasured", "traceAbsent");
    // Calls happened but nothing adjudicates them ⇒ the verdict is
    // unavailable. Nothing happened at all ⇒ nothing was captured. Two
    // different sentences for an operator, so they keep two reason codes.
    const tools = (e.spans ?? []).filter(isToolSpan);
    return tools.length > 0
      ? row("selection", "notMeasured", "matchVerdictUnavailable", {
          spanIds: spanIds(tools).slice(0, 5),
        })
      : row("selection", "notMeasured", "noEvidenceCaptured");
  }
  if (prompts.length > 0) {
    // A missing expected call is fatal in EVERY match mode, so it needs no
    // adjudication: `evaluateToolCalls` cannot return `passed` with a
    // non-empty `missing`.
    const missing = prompts.filter((p) => nonEmpty(p.missing));
    if (missing.length > 0) {
      return row("selection", "failed", "missingToolCall", {
        promptIndexes: promptIndexes(missing),
      });
    }
  }

  // Authored tool-call predicates, after the matcher's most specific verdict
  // and before its tolerated-extras logic. A failed predicate is a definite,
  // author-stated fact about which tool the model picked; the `unexpected`
  // branch below is the one that has to decide whether extras were tolerated.
  const failedPredicates = predicates.filter((r) => r.passed === false);
  if (failedPredicates.length > 0) {
    return row(
      "selection",
      "failed",
      selectionPredicateReason(failedPredicates),
      boundedPredicateReasons(failedPredicates)
    );
  }

  if (prompts.length > 0) {
    const unexpected = prompts.filter((p) => nonEmpty(p.unexpected));
    if (unexpected.length > 0) {
      // Extras are a failure ONLY when the turn's own verdict says so.
      // `maxExtraToolCalls` defaults to `null` — extras are reported and
      // tolerated — so a raw read of `unexpected` reports a PASSING agentic
      // run as failing at `selection`, then blanks every later stage behind
      // an `earlierStageFailed` that never happened.
      //
      // A turn that also carries argument mismatches is left to `call`: its
      // verdict cannot tell us WHICH of the two sank it, and blaming the
      // earlier stage on a guess is exactly the mis-attribution this whole
      // module exists to avoid.
      const adjudicatedFailures = unexpected.filter(
        (p) => p.passed === false && !nonEmpty(p.argumentMismatches)
      );
      if (adjudicatedFailures.length > 0) {
        return row("selection", "failed", "unexpectedToolCall", {
          promptIndexes: promptIndexes(adjudicatedFailures),
        });
      }
      const unadjudicated = unexpected.filter((p) => p.passed === undefined);
      if (unadjudicated.length > 0) {
        return row("selection", "notMeasured", "matchVerdictUnavailable", {
          promptIndexes: promptIndexes(unadjudicated),
        });
      }
      // Every turn carrying extras still passed its own gate: this case
      // tolerates them, and tolerated extras are not a selection defect.
      return row("selection", "passed", "observed", {
        promptIndexes: promptIndexes(prompts),
      });
    }
    return row("selection", "passed", "observed");
  }
  // Predicates that all PASSED are evidence too, not just blame: a case whose
  // only selection assertion is "never call the admin tool" and which did not
  // call it has measured selection and found it sound. Reporting that as
  // `notMeasured` would understate what the run actually established.
  if (predicates.length > 0) {
    return row("selection", "passed", "observed");
  }
  if (e.traceAbsent) return row("selection", "notMeasured", "traceAbsent");
  if (e.traceLacksSpanChannel) {
    return row("selection", "notMeasured", "executorEmitsNoSpans");
  }
  return row("selection", "notMeasured", "noEvidenceCaptured");
}

function deriveCall(
  e: StageEvidence,
  authored: StageAuthoredCase
): StageResultRow {
  const mismatched = (e.prompts ?? []).filter((p) =>
    nonEmpty(p.argumentMismatches)
  );
  if (mismatched.length > 0) {
    return row("call", "failed", "argumentMismatch", {
      promptIndexes: promptIndexes(mismatched),
    });
  }
  const tools = (e.spans ?? []).filter(isToolSpan);
  // A call that never produced a result: a JSON-RPC/transport failure carries
  // an `mcpErrorCode`; a DOMAIN error (`isError: true`) carries none by spec,
  // and belongs to `response`, not here.
  const protocolFailed = tools.filter(
    (s) => typeof s.mcpErrorCode === "number"
  );
  const protocolToolErrors = (e.toolErrors ?? []).filter(
    (t) => t.kind === "protocol-error"
  );
  if (protocolFailed.length > 0 || protocolToolErrors.length > 0) {
    return row("call", "failed", "protocolError", {
      spanIds: spanIds(protocolFailed).slice(0, 5),
    });
  }
  if (tools.length > 0) {
    return row("call", "passed", "observed", {
      spanIds: spanIds(tools).slice(0, 5),
    });
  }
  // A negative case asserts that NO call happens, and `applicability` turns
  // `call` on for exactly that reason. The turn summaries ARE the evidence
  // that the assertion held (they recorded zero unmatched actual calls), so
  // reporting `notMeasured` here would call the case's central assertion
  // unmeasured on every run where it holds.
  const negativePrompts = e.prompts ?? [];
  if (authored.isNegativeTest === true && negativePrompts.length > 0) {
    return row("call", "passed", "observed", {
      promptIndexes: promptIndexes(negativePrompts),
    });
  }
  if (e.traceAbsent) return row("call", "notMeasured", "traceAbsent");
  if (e.traceLacksSpanChannel) {
    return row("call", "notMeasured", "executorEmitsNoSpans");
  }
  return row("call", "notMeasured", "noEvidenceCaptured");
}

function deriveResponse(
  e: StageEvidence,
  authored: StageAuthoredCase
): StageResultRow {
  // An errored tool span with NO code is a domain error reported the
  // protocol-correct way: the server answered, with unusable data.
  const domainFailed = (e.spans ?? []).filter(
    (s) => isToolSpan(s) && spanFailed(s) && typeof s.mcpErrorCode !== "number"
  );
  // `hasObservedToolFailure` is the same condition, and it is what makes this
  // stage applicable on a case that authored nothing about tools — the two
  // must stay one rule, or a stage could be switched on and then found empty.
  if (hasObservedToolFailure(e)) {
    return row("response", "failed", "toolError", {
      spanIds: spanIds(domainFailed).slice(0, 5),
    });
  }
  if (authored.expectsWidgetRender) {
    const observations = e.renderObservations ?? [];
    if (observations.length === 0) {
      return row("response", "notMeasured", "noEvidenceCaptured");
    }
    // Only `"rendered"` is success; every other literal names the stage that
    // failed (`no_ui_resource`, `mount_failed`, `bridge_timeout`, …).
    if (observations.some((o) => o.status !== "rendered")) {
      return row("response", "failed", "renderFailed");
    }
    return row("response", "passed", "observed");
  }
  const okTools = (e.spans ?? []).filter(
    (s) => isToolSpan(s) && !spanFailed(s)
  );
  if (okTools.length > 0) {
    return row("response", "passed", "observed", {
      spanIds: spanIds(okTools).slice(0, 5),
    });
  }
  if (e.traceAbsent) return row("response", "notMeasured", "traceAbsent");
  if (e.traceLacksSpanChannel) {
    return row("response", "notMeasured", "executorEmitsNoSpans");
  }
  return row("response", "notMeasured", "noEvidenceCaptured");
}

function deriveUserValue(e: StageEvidence): StageResultRow {
  // Precedence: a broken grader outranks whatever it would have said. The run
  // says nothing about the server's user value, so `notMeasured` — never
  // `failed`, which would blame the server for our own bug.
  if (e.evaluatorErrored) {
    return row("userValue", "notMeasured", "evaluatorError");
  }
  // Tool-call predicates are ROUTED to `selection`, not copied into it: a
  // failure filed in both places would double-count one defect and, worse,
  // make `firstFailedStage` depend on which stage the reader looked at first.
  // What is left here is what actually speaks to the user's ask.
  const results = (e.predicateResults ?? []).filter(
    (r) => !isSelectionPredicateKind(r.predicate?.type)
  );
  if (results.length > 0) {
    const failed = results.filter((r) => r.passed === false);
    if (failed.length > 0) {
      return row(
        "userValue",
        "failed",
        "predicateFailed",
        boundedPredicateReasons(failed)
      );
    }
    return row("userValue", "passed", "observed");
  }
  if (e.traceAbsent) return row("userValue", "notMeasured", "traceAbsent");
  // TIER 2. Everything above is deterministic; a judge is only consulted once
  // the deterministic evidence has said nothing. An untraced run is not
  // judgeable, so `traceAbsent` still outranks a verdict.
  const judge = e.judgeEvidence;
  if (judge) {
    const evidence = boundedJudgeReasons(judge.reasons);
    if (judge.status === "scored") {
      if (judge.verdict === "pass") {
        return row("userValue", "passed", "judgeObserved", evidence);
      }
      if (judge.verdict === "partial") {
        return row("userValue", "failed", "judgePartial", evidence);
      }
      if (judge.verdict === "fail") {
        return row("userValue", "failed", "judgeFailed", evidence);
      }
    }
    if (judge.status === "error") {
      // The existing evaluator reason, so a judge that blew up buckets exactly
      // like any other broken grader — no new failure category.
      return row("userValue", "notMeasured", "evaluatorError", evidence);
    }
    if (judge.status === "pending") {
      return row(
        "userValue",
        "notMeasured",
        judge.pendingKind === "not_requested"
          ? "judgeNotRequested"
          : "judgePending",
        evidence
      );
    }
    // `skipped` / `not_applicable` fall through to the floor.
  }
  return row("userValue", "notMeasured", "noEvidenceCaptured");
}

/**
 * Predicate reasons under the row's evidence caps.
 *
 * Extracted so `selection` and `userValue` bound their reasons identically —
 * two copies of the same slice-and-ellipsis would be free to drift, and the
 * cap is what keeps a row from carrying an unbounded model-authored string.
 */
function boundedPredicateReasons(
  rows: readonly StagePredicateResultLike[]
): StageEvidenceRefs | undefined {
  const bounded = rows
    .map((r) => r.reason)
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .slice(0, MAX_EVIDENCE_REASONS)
    .map((r) =>
      r.length > MAX_EVIDENCE_REASON_CHARS
        ? `${r.slice(0, MAX_EVIDENCE_REASON_CHARS - 1)}…`
        : r
    );
  return bounded.length > 0 ? { predicateReasons: bounded } : undefined;
}

/**
 * Judge reasons under the SAME caps predicate reasons already obey.
 *
 * They land in `predicateReasons` — the refs type's only free-text slot —
 * rather than in a new field, because `StageEvidenceRefs` is mirrored by the
 * backend's row validator and a widened shape is a deploy-order hazard for a
 * cosmetic gain. The row's `reason` already says a judge decided it.
 */
function boundedJudgeReasons(
  reasons: readonly string[] | undefined
): StageEvidenceRefs | undefined {
  if (!reasons || reasons.length === 0) return undefined;
  const bounded = reasons
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .slice(0, MAX_EVIDENCE_REASONS)
    .map((r) =>
      r.length > MAX_EVIDENCE_REASON_CHARS
        ? `${r.slice(0, MAX_EVIDENCE_REASON_CHARS - 1)}\u2026`
        : r
    );
  return bounded.length > 0 ? { predicateReasons: bounded } : undefined;
}

/**
 * The coarse bucket a failing run is grouped under.
 *
 * `metadata` is reachable ONLY through `evidence.metadataAttribution` — D7's
 * advisory judge, consulted after `selection` already failed
 * deterministically. No deterministic span or predicate ever selects it: a
 * `selection` failure with no attribution verdict (or one that scored
 * `attributed: false`) stays `"selection"`, the same as before D7 shipped.
 * `evaluator` is only reached when the grader is the ONLY thing that broke —
 * a run whose server demonstrably failed is reported against the server, and
 * an evaluator error on top of that does not launder it.
 */
function categoryFor(
  firstFailed: UserValueStage | undefined,
  rows: readonly StageResultRow[],
  evidence: StageEvidence
): FailureCategory | undefined {
  if (!firstFailed) {
    if (evidence.evaluatorErrored) return "evaluator";
    // A model-call failure leaves nothing failed — there was nothing to fail
    // against. Before UVH-IN2 that produced a run with no category at all,
    // which reads as "we cannot say what went wrong" when in fact we can say
    // precisely: our provider did. `setup` is the existing bucket for our own
    // side breaking, which is why this needs no new category.
    if (evidence.stepError?.source === "model") return "setup";
    return undefined;
  }
  const failedRow = rows.find((r) => r.stage === firstFailed);
  switch (firstFailed) {
    case "connection":
    case "discovery":
      return "setup";
    case "selection": {
      const attribution = evidence.metadataAttribution;
      // Quoted evidence is required, not optional decoration: a `metadata`
      // classification with nothing backing it is unauditable, and
      // `mergeMetadataAttributionEvidence` below already no-ops without it —
      // so recoloring here without the same check would claim a category
      // whose own row carries no supporting evidence at all.
      return attribution?.status === "scored" &&
        attribution.attributed === true &&
        boundedJudgeReasons(attribution.reasons) !== undefined
        ? "metadata"
        : "selection";
    }
    case "call":
      if (failedRow?.reason === "argumentMismatch") return "arguments";
      // A transport-local code is OUR side, not the server's.
      return (evidence.spans ?? []).some(
        (s) =>
          typeof s.mcpErrorCode === "number" &&
          TRANSPORT_LOCAL_MCP_CODES.has(s.mcpErrorCode)
      )
        ? "setup"
        : "serverData";
    case "response":
      return "serverData";
    case "userValue":
      return "userValue";
  }
}

/**
 * Derive the six stage rows for one iteration.
 *
 * Pure and deterministic. Always returns exactly six rows in
 * `USER_VALUE_STAGES` order — position is how `notReached` is derived, so the
 * result must never be sorted or re-slotted by a caller.
 */
export function deriveStageResults(
  input: StageDerivationInput
): StageDerivation {
  const { authored, evidence, iteration, policy } = input;
  const applies = applicability(authored, evidence);

  const inapplicable = (stage: UserValueStage) =>
    row(stage, "notApplicable", "notAuthored");

  // Precedence 1: a policy block. Nothing was measured and nothing failed —
  // representing it as a failure would blame the server for our own gate.
  if (policy?.blocked) {
    return finalize(
      USER_VALUE_STAGES.map((stage) =>
        applies[stage]
          ? row(stage, "notMeasured", "blockedByPolicy")
          : inapplicable(stage)
      ),
      evidence
    );
  }

  // A setup abort, whether it wears `setup_failed` or the `failed` the older
  // writer could spell (`persistSetupFailedIteration` predates the widened
  // update mutation). Its setup signals are the only thing that can name WHOSE
  // side broke, so a stopped status must not discard them.
  const noEvidenceAtAll =
    (evidence.spans?.length ?? 0) === 0 &&
    (evidence.prompts?.length ?? 0) === 0 &&
    (evidence.predicateResults?.length ?? 0) === 0;
  const hasSetupSignals =
    evidence.setupSignals?.connection !== undefined ||
    evidence.setupSignals?.discovery !== undefined;
  const isSetupAbort =
    (iteration.status === "failed" || iteration.status === "setup_failed") &&
    evidence.traceAbsent &&
    noEvidenceAtAll;

  // Precedence 2: the run never produced a verdict. Harness noise must not
  // inflate any server failure rate, so nothing here is ever `failed` unless
  // setup signals measured the other side's server saying no.
  if (LIFECYCLE_STOPPED.has(iteration.status) && !isSetupAbort) {
    const reason: StageReason =
      iteration.status === "setup_failed" ? "setupAborted" : "lifecycleStopped";
    return finalize(
      USER_VALUE_STAGES.map((stage) =>
        applies[stage] ? row(stage, "notMeasured", reason) : inapplicable(stage)
      ),
      evidence,
      "setup"
    );
  }

  if (isSetupAbort) {
    // No signals ⇒ byte-identical to the v1 chain (modulo analyzer version).
    if (!hasSetupSignals) {
      return finalize(
        USER_VALUE_STAGES.map((stage) =>
          applies[stage]
            ? row(stage, "notMeasured", "setupAborted")
            : inapplicable(stage)
        ),
        evidence,
        "setup"
      );
    }
    // Signals present ⇒ measure the top two stages. Remaining stages are
    // `notReached` after a measured failure, else `notMeasured/setupAborted`.
    // `failureCategory` stays `setup` (no honest `server` bucket; rates
    // filter on `firstFailedStage`).
    const connection = deriveConnection(evidence);
    const discoveryRaw = deriveDiscovery(evidence);
    const discovery =
      connection.state === "failed" && discoveryRaw.state === "notMeasured"
        ? row("discovery", "notReached", "earlierStageFailed")
        : discoveryRaw;
    const topFailed =
      connection.state === "failed" || discovery.state === "failed";
    const rest = USER_VALUE_STAGES.slice(2).map((stage) =>
      applies[stage]
        ? topFailed
          ? row(stage, "notReached", "earlierStageFailed")
          : row(stage, "notMeasured", "setupAborted")
        : inapplicable(stage)
    );
    return finalize([connection, discovery, ...rest], evidence, "setup");
  }

  const upstream: StageResultRow[] = USER_VALUE_STAGES.slice(0, 5).map(
    (stage) => {
      if (!applies[stage]) return inapplicable(stage);
      switch (stage) {
        case "connection":
          return deriveConnection(evidence);
        case "discovery":
          return deriveDiscovery(evidence);
        case "selection":
          return deriveSelection(evidence, authored);
        case "call":
          return deriveCall(evidence, authored);
        default:
          return deriveResponse(evidence, authored);
      }
    }
  );

  // A judge verdict is DISCARDED when the chain broke upstream. The advisory
  // input only ever fills a silence deterministic evidence left in a run that
  // otherwise got as far as user value; on a run whose connection or tool call
  // failed, "the judge says the user got what they wanted" is a claim the run
  // itself disproves, and it would overwrite `notReached` with a verdict.
  const brokeUpstream = upstream.some((r) => r.state === "failed");
  const userValueEvidence =
    brokeUpstream && evidence.judgeEvidence
      ? { ...evidence, judgeEvidence: undefined }
      : evidence;

  const derived: StageResultRow[] = [
    ...upstream,
    applies.userValue
      ? deriveUserValue(userValueEvidence)
      : inapplicable("userValue"),
  ];

  // Precedence 3: position — but only over stages that decided NOTHING of
  // their own.
  //
  // `notReached` after the first failure is right for a stage with no evidence:
  // the chain broke upstream and that is why we know nothing. It is FALSE for a
  // stage that was measured. A case whose `selection` failed on a stray call
  // still made the expected call and still ran its predicates; overwriting
  // those measured rows with "never ran" destroys the evidence an operator
  // needs and states something the run disproves. `firstFailedStage` already
  // carries "where the chain broke" — the rows do not have to lie to say it.
  // WITHDRAWN FIRST, then cascaded — the order matters and getting it wrong
  // produces a chain that argues with itself.
  //
  // The cascade reads `failed` rows to decide which later stages "never ran".
  // Withdrawing a provider-blocked failure AFTER it has run leaves the
  // downstream rows still saying `earlierStageFailed` while no stage failed
  // and no `firstFailedStage` exists — three rows citing a failure the chain
  // no longer records. Running the withdrawal first means the cascade sees the
  // rows as they will actually be reported, so a provider outage marks the
  // later stages `providerError` (which is why they were not measured) rather
  // than blaming a stage that is no longer failed.
  //
  // A failure the provider did NOT explain still cascades exactly as before:
  // `unexpectedToolCall` at `selection` survives the withdrawal, stays the
  // first failed row, and the stages after it still read `notReached`.
  const withdrawn = applyProviderError(derived, evidence);
  const firstFailedIndex = withdrawn.findIndex((r) => r.state === "failed");
  const rows =
    firstFailedIndex < 0
      ? withdrawn
      : withdrawn.map((r, i) =>
          i > firstFailedIndex && r.state === "notMeasured"
            ? row(r.stage, "notReached", "earlierStageFailed")
            : r
        );

  return finalize(rows, evidence);
}

/**
 * Merge D7's quoted evidence into the `selection` row, but ONLY when the
 * resolved category actually landed on `metadata` — i.e. `categoryFor`'s
 * `selection` branch consulted a scored+attributed verdict.
 *
 * Reuses `boundedJudgeReasons` and `evidence.predicateReasons` — the row
 * refs' only free-text slot, same precedent `judgeEvidence` set for
 * `userValue` — rather than a new field. Any `promptIndexes` already on the
 * row (from `deriveSelection`'s `missingToolCall` / `unexpectedToolCall`) are
 * preserved untouched: the judge explains WHY those turns failed, it does
 * not relocate them. The row's own `reason` is never touched either.
 *
 * NO discard is needed on the way in, unlike `judgeEvidence`'s explicit strip
 * in `deriveStageResults`: `categoryFor`'s `selection` branch is only ever
 * reached when `firstFailedStage === "selection"`, which — by `finalize`'s
 * own positional definition — means nothing upstream (`connection` /
 * `discovery`) already broke. `metadataAttribution` can therefore never be
 * consulted on a run whose chain broke before `selection` even ran.
 */
function mergeMetadataAttributionEvidence(
  rows: readonly StageResultRow[],
  metadataAttribution: StageEvidence["metadataAttribution"]
): StageResultRow[] {
  const reasonsEvidence = boundedJudgeReasons(metadataAttribution?.reasons);
  if (!reasonsEvidence) return rows as StageResultRow[];
  return rows.map((r) =>
    r.stage === "selection"
      ? { ...r, evidence: { ...r.evidence, ...reasonsEvidence } }
      : r
  );
}

/**
 * Reasons a stage reported NOTHING, which a model-call failure explains.
 *
 * Each reads as "we looked and the server told us nothing" — an accusation,
 * when the truth is that our own provider never let us ask.
 */
const PROVIDER_BLANKED_REASONS: ReadonlyArray<StageReason | undefined> = [
  "noEvidenceCaptured",
  "traceAbsent",
  "executorEmitsNoSpans",
];

/**
 * Failure reasons that conclude from something NOT HAPPENING.
 *
 * This is the distinction that decides whether a `failed` row survives a
 * provider outage, and it is the whole of the second half of this function.
 *
 * An ABSENCE verdict — no tool call arrived, an assertion over the output did
 * not hold, the judge scored a transcript low — is only sound if the run was
 * allowed to finish. When our own model call died first, "it did not happen"
 * has a second explanation that outranks the accusation, and we cannot tell
 * which is true. The honest answer is that we did not measure it.
 *
 * PRESENCE verdicts are deliberately absent from this list and keep their
 * rows: an unexpected call was really made, arguments really mismatched, a
 * tool really errored, a render really failed. Those observations stand
 * whatever killed the turn afterwards. `connectFailed` and `toolsListFailed`
 * matter most here — they happen BEFORE any model call, so a server that would
 * not connect must never be excused by a provider error that came later.
 */
const PROVIDER_UNKNOWABLE_FAILURES: ReadonlyArray<StageReason | undefined> = [
  "missingToolCall",
  "predicateFailed",
  "judgePartial",
  "judgeFailed",
];

/**
 * Re-label what a MODEL-CALL failure made unknowable.
 *
 * Applied BEFORE the positional cascade, and again in `finalize` for the
 * early-return paths that never reach it — idempotent, so the second pass over
 * already-converted rows finds nothing to do. An earlier revision of this
 * docblock said "applied last"; that was true until the withdrawal had to move
 * ahead of the cascade, which reads `failed` rows to decide which later stages
 * never ran. Withdrawing after it ran left three rows citing a failure the
 * chain no longer recorded. See the comment at the call site.
 *
 * Two parts.
 *
 * BLANK ROWS. A stage that measured nothing is re-labelled, while a stage with
 * its own evidence keeps its own row: the provider dying at turn 4 does not
 * un-observe what turns 1-3 established.
 *
 * FAILED ROWS THAT REST ON AN ABSENCE. The first version of this stopped at
 * blank rows, and that left the fix inert on the shape it matters most for. A
 * case expecting a tool call whose provider died first still had
 * `selection: failed / missingToolCall` written by the matcher before this
 * ever ran — so `firstFailedStage` stayed `selection`, `categoryFor` returned
 * `selection`, and the outage was filed as a model-selection defect. The one
 * thing this reason exists to prevent, on the most common case in the corpus.
 *
 * `notMeasured` throughout, never `failed`. A run that could not be attempted
 * has measured nothing about the server, and inflating a server failure rate
 * with our own outage is exactly what this reason exists to prevent.
 */
function applyProviderError(
  rows: StageResultRow[],
  evidence: StageEvidence
): StageResultRow[] {
  if (evidence.stepError?.source !== "model") return rows;
  return rows.map((r) => {
    if (
      r.state === "notMeasured" &&
      PROVIDER_BLANKED_REASONS.includes(r.reason)
    ) {
      return { ...r, reason: "providerError" as const };
    }
    if (
      r.state === "failed" &&
      PROVIDER_UNKNOWABLE_FAILURES.includes(r.reason)
    ) {
      // The EVIDENCE goes with the verdict it supported. Those lines say why
      // the absence was judged a failure, and that judgement is exactly what
      // is being withdrawn — keeping them would leave a `notMeasured` row
      // arguing for a failure it no longer claims.
      const { evidence: _dropped, ...rest } = r;
      return {
        ...rest,
        state: "notMeasured" as const,
        reason: "providerError" as const,
      };
    }
    return r;
  });
}

function finalize(
  rows: StageResultRow[],
  evidence: StageEvidence,
  forcedCategory?: FailureCategory
): StageDerivation {
  // IDEMPOTENT, and applied here as well as before the positional cascade: the
  // early-return paths above never reach that cascade, so this is the only
  // place they get it. A second pass over rows the first already converted
  // finds nothing left to change — `providerError` is in neither list.
  rows = applyProviderError(rows, evidence);
  const firstFailedStage = rows.find((r) => r.state === "failed")?.stage;
  const failureCategory =
    forcedCategory ?? categoryFor(firstFailedStage, rows, evidence);
  const finalRows =
    failureCategory === "metadata"
      ? mergeMetadataAttributionEvidence(rows, evidence.metadataAttribution)
      : rows;
  return {
    stageResults: finalRows,
    ...(firstFailedStage ? { firstFailedStage } : {}),
    ...(failureCategory ? { failureCategory } : {}),
    stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
  };
}

// ── validators ───────────────────────────────────────────────────────────────
//
// The single source of truth for what a PERSISTED derivation may look like,
// used at every write boundary that accepts one from a client. Kept beside the
// analyzer (which never references them) so the two cannot drift.

export const stageReasonSchema = z.enum(STAGE_REASONS);

export const stageResultRowSchema = z.object({
  stage: userValueStageSchema,
  state: stageStateSchema,
  reason: stageReasonSchema.optional(),
  evidence: z
    .object({
      spanIds: z.array(z.string()).optional(),
      promptIndexes: z.array(z.number()).optional(),
      predicateReasons: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * A derivation as persisted.
 *
 * The `superRefine` is the load-bearing part: it re-asserts the two invariants
 * that make the rows readable at all — exactly six rows, in `USER_VALUE_STAGES`
 * order. A payload that arrives sorted alphabetically would otherwise validate
 * field-by-field while reporting a completely different set of blocked stages.
 */
export const stageDerivationSchema = z
  .object({
    stageResults: z.array(stageResultRowSchema),
    firstFailedStage: userValueStageSchema.optional(),
    failureCategory: failureCategorySchema.optional(),
    stageAnalyzerVersion: z.number().int().nonnegative(),
  })
  .superRefine((value, ctx) => {
    if (value.stageResults.length !== USER_VALUE_STAGES.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stageResults"],
        message: `expected ${USER_VALUE_STAGES.length} stage rows, received ${value.stageResults.length}`,
      });
      return;
    }
    USER_VALUE_STAGES.forEach((stage, index) => {
      if (value.stageResults[index]?.stage !== stage) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stageResults", index, "stage"],
          message: `stage rows must be in USER_VALUE_STAGES order; expected "${stage}" at index ${index}`,
        });
      }
    });
    const firstFailed = value.stageResults.find((r) => r.state === "failed");
    if (firstFailed && value.firstFailedStage !== firstFailed.stage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["firstFailedStage"],
        message: `firstFailedStage must name the first failed row ("${firstFailed.stage}")`,
      });
    }
    if (!firstFailed && value.firstFailedStage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["firstFailedStage"],
        message: "firstFailedStage is set but no stage row failed",
      });
    }
  });

/**
 * The metadata keys a derivation occupies on `testIteration.metadata`.
 *
 * Exported so every writer and every validator names them identically rather
 * than spelling the strings again.
 */
export const STAGE_METADATA_KEYS = [
  "stageResults",
  "firstFailedStage",
  "failureCategory",
  "stageAnalyzerVersion",
] as const;

/** Flatten a derivation into the metadata keys it persists under. */
export function stageDerivationToMetadata(
  derivation: StageDerivation
): Record<string, unknown> {
  return {
    stageResults: derivation.stageResults,
    ...(derivation.firstFailedStage
      ? { firstFailedStage: derivation.firstFailedStage }
      : {}),
    ...(derivation.failureCategory
      ? { failureCategory: derivation.failureCategory }
      : {}),
    stageAnalyzerVersion: derivation.stageAnalyzerVersion,
  };
}
