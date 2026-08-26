/**
 * The ONE way a chat session's evidence becomes a user-value chain.
 *
 * `deriveStageResults` (`./stage-derivation.ts`) is the only derivation
 * function on any surface, and D8 does not add a second one. What D8 adds is
 * this: a PURE adapter that maps what a chat session actually captured —
 * readiness, deterministic criteria, a goal judge, trace spans — onto the
 * analyzer's `StageDerivationInput`. Three sources feed it today (real User
 * Testing sessions, swarm journey sessions, and direct/playground sessions
 * once D8p persists their evidence) and they differ only in which fields are
 * populated, never in how a stage is decided.
 *
 * The split matters: normalizing evidence is a per-surface job, deciding a
 * stage is not. A second surface that derived its own rows would be a second
 * definition of "the connection worked", and two definitions is how one
 * dashboard says a server is fine while another says it is broken.
 *
 * PURE and deterministic, same as the analyzer: no ctx, no network, no LLM, no
 * clock. Convex validates and persists what comes out; React renders it.
 * Neither derives.
 *
 * ── The rules this file exists to enforce ────────────────────────────────────
 *
 *  1. **A tool call does not prove selection.** A chat session authors no
 *     expected calls, so there is nothing for "the model picked the right
 *     tool" to be measured against. Every session here is emitted with
 *     `toolExpectation: "open"`, which the analyzer reads as "a bare call can
 *     never make `selection` pass". `selection` on a chat session is
 *     `notMeasured` until something explicitly adjudicates it.
 *
 *  2. **Readiness is evidence, not a verdict.** A readiness record is a
 *     deterministic report about tool inventory and tool errors. It can
 *     establish that we reached the server and read its tools; it is never
 *     translated into a stage state directly, and `verdict: "not_ready"` is
 *     NOT a failed chain.
 *
 *  3. **Deterministic criteria outrank the judge.** Production checks (User
 *     Testing) and the swarm rubric are the authoritative user-value evidence
 *     wherever they are configured. The goal judge is consulted only where
 *     they are silent — and never where they BROKE (see
 *     {@link buildChatSessionStageInput}'s `criteria.status === "failed"`
 *     branch), because a broken grader is silence about the grader, not a
 *     licence to substitute a different one.
 *
 *  4. **A broken grader is `notMeasured`.** Never a product failure. A rate
 *     that counts our own bugs as the server's bugs is worse than no rate.
 *
 *  5. **No connection failure is manufactured.** Chat sessions carry no
 *     connect/tools-list phase signals and no egress canary, so this adapter
 *     never emits `setupSignals` at all. `connection` is established
 *     POSITIVELY (spans, or a known advertised inventory) or it stays
 *     `notMeasured`. There is no path here that produces
 *     `connection: failed`.
 *
 *  6. **An ask with no grader is `notMeasured`; no ask is `notApplicable`.**
 *     The two are different claims and the chain keeps them apart.
 */

import type {
  StageAuthoredCase,
  StageDerivationInput,
  StageEvidence,
  StagePredicateResultLike,
  StageSpanLike,
} from "./stage-derivation.js";
import type { IterationStatus } from "./chain.js";

/**
 * Which chat surface produced the session.
 *
 * Present so a stored derivation records what it was derived FROM — the
 * denominators these rows feed are per-surface and must never be merged (a
 * User Testing funnel and a swarm funnel answer different questions, and
 * neither is an eval trial). The adapter itself branches on it in exactly one
 * place: nowhere. Every source maps evidence the same way; what differs is
 * which evidence exists.
 */
export const CHAT_SESSION_STAGE_SOURCES = [
  /** A real User Testing (scenario) session. */
  "user_testing",
  /** A swarm / journey-execution session. */
  "swarm",
  /** A direct / playground session (D8p). */
  "direct",
] as const;
export type ChatSessionStageSource =
  (typeof CHAT_SESSION_STAGE_SOURCES)[number];

/**
 * The deterministic readiness record, as persisted.
 *
 * Only the fields that can establish an UPSTREAM stage are read. The verdict
 * and the issue list are deliberately absent from the mapping: they are a
 * summary for a human, and turning `not_ready` into `failed` would be exactly
 * the aggregate-into-verdict move rule 2 forbids.
 */
export type ChatSessionReadinessEvidence = {
  status: "pending" | "completed" | "partial" | "failed";
  /** Tool spans observed. */
  toolCallCount?: number;
  /** How many tools the host advertised. Only meaningful when known. */
  advertisedToolCount?: number;
  /**
   * False when the tool snapshot was missing or still inspecting. An UNKNOWN
   * inventory establishes nothing — `advertisedToolCount: 0` under
   * `advertisedToolsKnown: false` is "we did not look", not "there were none".
   */
  advertisedToolsKnown?: boolean;
};

/** One deterministic criterion's outcome. */
export type ChatSessionCriterionOutcome = {
  criterionId: string;
  passed: boolean;
};

/**
 * Deterministic criteria: the production-scoring rubric for a real User
 * Testing session, or the pinned journey rubric for a swarm session. Same
 * shape, same authority — the AUTHORITATIVE user-value evidence when
 * configured.
 *
 * The three statuses are three different answers and none of them is absence:
 * absent means no rubric was ever configured.
 */
export type ChatSessionCriteriaEvidence = {
  /**
   * `pending`   — claimed, not finished. A verdict is owed.
   * `completed` — `results` carries one row per evaluated criterion.
   * `failed`    — the GRADER broke. NOT "the criteria failed".
   */
  status: "pending" | "completed" | "failed";
  /** Present on `completed`. An empty array is a rubric with no entries. */
  results?: readonly ChatSessionCriterionOutcome[];
  /**
   * The criteria this session was CLAIMED against — the grade's scope.
   *
   * It is what makes an empty `results` legible. Zero rows against an empty
   * scope is a real "there was no rubric"; zero rows against a scope that
   * named criteria is a grade we could not read, and the two must not reduce
   * to the same silence — the second would hand `userValue` to the goal judge
   * on a session whose deterministic rubric was supposed to answer it.
   *
   * Absent means the scope is unknown (a row written before the field
   * existed), which is treated as "not explicitly empty".
   */
  criterionIds?: readonly string[];
};

/**
 * The swarm goal-completion judge's compact verdict.
 *
 * TIER 2 by construction: it is only ever consulted where deterministic
 * criteria said nothing at all.
 */
export type ChatSessionGoalJudgeEvidence = {
  status: "running" | "completed" | "failed";
  /** Present on `completed`. */
  passed?: boolean;
  /** The judge's one-line justification, if any. Bounded by the analyzer. */
  reason?: string;
};

/** Where the session is in its own life. */
export type ChatSessionLifecycle =
  /** Still being written to. Derivable, but its evidence is partial. */
  | "running"
  /** Finished naturally — the normal case. */
  | "settled"
  /** Stopped mid-flight (cancelled attempt, abandoned run). */
  | "stopped";

/** Everything a chat surface hands the adapter. */
export type ChatSessionStageInput = {
  source: ChatSessionStageSource;
  /**
   * Does a real user ask exist? Drives `userValue` APPLICABILITY and nothing
   * else — it never contributes to a pass or a failure.
   *
   * For a User Testing or direct session this is "at least one user turn with
   * content". For a swarm session it is the journey goal the persona was
   * driving toward. A session with no ask (an opened-and-abandoned transcript)
   * gets `userValue: notApplicable`, which is the honest answer: there was
   * nothing to satisfy.
   */
  hasUserAsk: boolean;
  lifecycle: ChatSessionLifecycle;
  /**
   * Normalized trace spans. `NormalizedSdkTraceSpan` (backend) and
   * `EvalTraceSpan` (inspector) both satisfy this structurally.
   */
  spans?: readonly StageSpanLike[];
  /** True when the session persisted no trace at all. */
  traceAbsent?: boolean;
  readiness?: ChatSessionReadinessEvidence;
  criteria?: ChatSessionCriteriaEvidence;
  goalJudge?: ChatSessionGoalJudgeEvidence;
};

/**
 * The authored-case half.
 *
 * `model_driven` always: every chat surface has a model choosing tools. That
 * makes `selection` APPLICABLE — and rule 1 is what keeps it from ever passing
 * vacuously, rather than declaring it inapplicable and hiding the gap.
 *
 * `assertionCount` stays 0 deliberately even when criteria are configured: it
 * counts AUTHORED assertions on a test case, and a chat session authors none.
 * `hasUserAsk` is what makes `userValue` applicable here, and the criteria
 * arrive as evidence, not as authoring.
 */
export function buildChatSessionAuthoredCase(
  input: Pick<ChatSessionStageInput, "hasUserAsk">
): StageAuthoredCase {
  return {
    mode: "model_driven",
    expectsToolCall: false,
    expectsWidgetRender: false,
    assertionCount: 0,
    hasUserAsk: input.hasUserAsk,
    toolExpectation: "open",
  };
}

/**
 * Map readiness onto the ONE analyzer field it may legitimately establish.
 *
 * A known, non-empty advertised inventory means we reached the host and read
 * its tools — which is what `connection` and `discovery` ask. An unknown
 * inventory establishes nothing, and this returns `undefined` rather than a
 * zero that would read as "the server advertised no tools".
 */
function toolSignalsFrom(
  readiness: ChatSessionReadinessEvidence | undefined
): StageEvidence["toolSignals"] {
  if (!readiness) return undefined;
  if (readiness.advertisedToolsKnown !== true) return undefined;
  const advertised = readiness.advertisedToolCount ?? 0;
  if (advertised <= 0) return undefined;
  return { toolsTotalBefore: advertised, toolsExposed: advertised };
}

/**
 * Deterministic criteria become predicate results — the analyzer's own
 * deterministic user-value channel, which no judge can overturn.
 *
 * No `reason` is carried. The evaluator's rationale lives on the check row and
 * is unbounded free text; copying it into a stage row would put grader prose
 * into every list payload that renders a chain, and the row's `reason` code
 * already says a deterministic criterion decided it.
 */
function predicateResultsFrom(
  criteria: ChatSessionCriteriaEvidence | undefined
): readonly StagePredicateResultLike[] | undefined {
  if (criteria?.status !== "completed") return undefined;
  const results = criteria.results ?? [];
  // A rubric with no entries graded nothing. Returning `[]` would make
  // `deriveUserValue` report `passed` off an empty set — the exact vacuity the
  // analyzer's non-vacuity rule forbids.
  if (results.length === 0) return undefined;
  return results.map((entry) => ({ passed: entry.passed }));
}

/**
 * The judge half of `userValue`, or the "a verdict is owed / was never owed"
 * marker that keeps an ungraded ask honest.
 *
 * Precedence, in one place:
 *
 *   1. Deterministic criteria BROKE ⇒ `undefined`, and the caller sets
 *      `evaluatorErrored`. A judge must not be promoted into the silence left
 *      by a grader that failed: "the deterministic check crashed, so we asked
 *      a model instead" is a different measurement wearing the same label.
 *   2. Deterministic criteria SPOKE ⇒ `undefined`. They are authoritative and
 *      `deriveUserValue` never reaches the judge once predicate results exist;
 *      dropping it here says so explicitly rather than relying on that.
 *   3. Deterministic criteria are PENDING ⇒ a verdict is owed and has not
 *      arrived. `judgePending` — never a pass, never a failure.
 *   4. No criteria configured ⇒ the goal judge fills the silence, if there is
 *      one.
 *   5. Nothing at all, but an ask exists ⇒ `judgeNotRequested`, which the
 *      analyzer reports as `notMeasured`. This is rule 6's "ask without a
 *      grader", and it is the single most important row in this file: it is
 *      what stops an unmeasured chat session from rendering as a green chain.
 */
function judgeEvidenceFrom(
  input: ChatSessionStageInput
): StageEvidence["judgeEvidence"] {
  const { criteria, goalJudge, hasUserAsk } = input;

  if (criteria?.status === "failed") return undefined;
  if (criteria?.status === "completed") {
    // A rubric that produced rows is authoritative — the judge never displaces
    // it.
    if ((criteria.results ?? []).length > 0) return undefined;
    // Zero rows. Only an EXPLICITLY empty scope means "there was no rubric",
    // and only that silence may be filled by the judge. Zero rows against a
    // scope that named criteria — or against a scope we cannot see — is a
    // grade we failed to read, and letting the judge answer there is how a
    // deterministic rubric silently loses to a model's opinion.
    if (criteria.criterionIds?.length === 0) {
      // fall through to the judge
    } else {
      return { status: "pending", pendingKind: "scheduled" };
    }
  } else if (criteria?.status === "pending") {
    return { status: "pending", pendingKind: "scheduled" };
  }

  if (goalJudge) {
    if (goalJudge.status === "completed" && goalJudge.passed !== undefined) {
      return {
        status: "scored",
        verdict: goalJudge.passed ? "pass" : "fail",
        ...(goalJudge.reason ? { reasons: [goalJudge.reason] } : {}),
      };
    }
    if (goalJudge.status === "failed") {
      // A broken judge is a broken grader: `notMeasured`, same bucket as any
      // other evaluator error, never a product failure.
      return { status: "error" };
    }
    if (goalJudge.status === "running") {
      return { status: "pending", pendingKind: "scheduled" };
    }
  }

  if (!hasUserAsk) return undefined;
  return { status: "pending", pendingKind: "not_requested" };
}

/**
 * Session lifecycle → the analyzer's iteration status.
 *
 * `stopped` maps to `cancelled`, which the analyzer treats as "no verdict was
 * ever produced" and reports as `notMeasured` across the board rather than
 * inflating a failure rate with an abandoned transcript.
 */
function iterationStatusFrom(lifecycle: ChatSessionLifecycle): IterationStatus {
  switch (lifecycle) {
    case "running":
      return "running";
    case "stopped":
      return "cancelled";
    default:
      return "completed";
  }
}

/**
 * Normalize one chat session's evidence into the analyzer's input.
 *
 * Everything this returns is structural and inspectable — the caller is
 * expected to hand it straight to `deriveStageResults`, and a test can assert
 * on the normalized shape without running the analyzer at all.
 */
export function buildChatSessionStageInput(
  input: ChatSessionStageInput
): StageDerivationInput {
  const evidence: StageEvidence = {
    ...(input.traceAbsent ? { traceAbsent: true } : {}),
    ...(input.spans && input.spans.length > 0 ? { spans: input.spans } : {}),
  };

  const toolSignals = toolSignalsFrom(input.readiness);
  if (toolSignals) evidence.toolSignals = toolSignals;

  const predicateResults = predicateResultsFrom(input.criteria);
  if (predicateResults) evidence.predicateResults = predicateResults;

  // Rule 4, and rule 3's second half: the deterministic grader breaking is the
  // ONLY thing this flag ever means here. It outranks whatever a judge would
  // have said, which is why `judgeEvidenceFrom` returns nothing in that case.
  if (input.criteria?.status === "failed") evidence.evaluatorErrored = true;

  const judgeEvidence = judgeEvidenceFrom(input);
  if (judgeEvidence) evidence.judgeEvidence = judgeEvidence;

  return {
    authored: buildChatSessionAuthoredCase(input),
    evidence,
    iteration: { status: iterationStatusFrom(input.lifecycle) },
  };
}
