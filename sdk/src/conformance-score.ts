/**
 * The conformance score: one number, 0–100, computable for any suite and for
 * all of them pooled.
 *
 * The shape is grounded in the spec's own doctrine rather than invented:
 *
 *   - The spec (every version's `basic/index.mdx`) defines requirement levels
 *     via BCP 14 / RFC 2119 and has no conformance clause beyond them —
 *     conformance IS the MUSTs. So MUSTs own 95 of the 100 points.
 *   - SEP-2484 (Final): "Checks for SHOULD-level requirements report as
 *     warnings rather than failures. MAY requirements do not need rows."
 *     Advice therefore factors into the number — the last 5 points — but can
 *     never masquerade as a failure: a MUST-clean server scores ≥95 no matter
 *     how much advice fired.
 *   - SEP-1730 sets tier lines at 100% and 80%; the 95/5 split keeps advice
 *     from ever demoting a MUST-clean server across either line. The 95–100
 *     band is reserved for runs that are MUST-clean and complete (a failed or
 *     incomplete run caps at 94), so a violating server can never outrank a
 *     clean-but-advised one and reading ≥95 always means the same thing.
 *   - RFC 2119 makes RECOMMENDED the SHOULD tier ("SHOULD — this word, or the
 *     adjective RECOMMENDED") and MAY the weakest, hence −2 / −1.
 *
 * The denominator rules come from `conformance-outcome.ts` and are what make
 * the score honest:
 *
 *   - `not-applicable` checks leave the denominator entirely — a server
 *     without auth, a stdio server's HTTP checks, a legacy pin's modern
 *     checks: none of them cost points.
 *   - `could-not-run` checks stay IN the denominator as unearned points, so
 *     an incomplete run can never display 100.
 *   - `pending` checks — ones the run's conformance profile does not score yet
 *     (see `conformance-profile.ts`) — leave the denominator AND the verdict.
 *     A newly added MUST check must not silently re-grade every server that
 *     was green before it existed; promoting it is a profile version bump.
 *
 * 100 therefore means exactly one thing: every applicable check ran and
 * passed, and nothing was left to advise.
 *
 * Pure data reasoning — no MCP client, no transport, no Node built-ins — so
 * it is exported from the browser entry alongside the catalog.
 */

import {
  decideConformanceOutcome,
  isInapplicableCheck,
  isUnrunCheck,
  type ConformanceRunOutcome,
  type OutcomeCheckLike,
} from "./conformance-outcome.js";
import {
  partitionByStamp,
  type ConformanceProfileStamp,
} from "./conformance-profile.js";
import type { MCPConformanceResult } from "./mcp-conformance/types.js";
import type {
  MCPAppsConformanceResult,
} from "./apps-conformance/types.js";
import type {
  MCPTasksConformanceResult,
} from "./tasks-conformance/types.js";
import type {
  ConformanceResult as OAuthConformanceResult,
} from "./oauth-conformance/types.js";

/** MUSTs own this many of the 100 points; advice owns the remainder. */
const MUST_POINTS = 95;
const ADVICE_POINTS = 100 - MUST_POINTS;
/** Per RFC 2119, RECOMMENDED is the SHOULD tier; MAY is the weakest. */
const DEDUCTION_BY_TIER = { should: 2, may: 1 } as const;

export type ConformanceAdvisoryTier = keyof typeof DEDUCTION_BY_TIER;

/** One piece of advice that costs points: a readiness warning, a check warning. */
export interface ScoredAdvisory {
  id: string;
  tier: ConformanceAdvisoryTier;
}

export interface ConformanceScore {
  /**
   * 0–100, or null when nothing was applicable — a server with no applicable
   * checks has nothing to claim a number ABOUT, and inventing one would let a
   * vacuous run outrank a real one.
   */
  score: number | null;
  outcome: ConformanceRunOutcome;
  /** The denominator: passed + failed + couldNotRun. Always display it. */
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  /**
   * Checks that ran and reported a verdict the active conformance profile does
   * NOT score yet (see `conformance-profile.ts`). Excluded from `applicable`,
   * from `passed`/`failed`/`couldNotRun`, and from the outcome — a check
   * arriving in the pool must not re-grade servers that were already green.
   * Always 0 for a result with no profile stamp.
   */
  pending: number;
  advisories: ScoredAdvisory[];
  /** Points the advisories cost, after the cap. */
  advicePointsLost: number;
  /** The revision the score was judged against. Always display it. */
  protocolVersion?: string;
}

function adviceDeduction(advisories: ScoredAdvisory[]): number {
  const raw = advisories.reduce(
    (sum, advisory) => sum + DEDUCTION_BY_TIER[advisory.tier],
    0,
  );
  return Math.min(raw, ADVICE_POINTS);
}

function scoreFromCounts(
  counts: Pick<
    ConformanceScore,
    "passed" | "failed" | "couldNotRun" | "notApplicable"
  > &
    Partial<Pick<ConformanceScore, "pending">>,
  advisories: ScoredAdvisory[],
  outcome: ConformanceRunOutcome,
  protocolVersion?: string,
): ConformanceScore {
  const applicable = counts.passed + counts.failed + counts.couldNotRun;
  const advicePointsLost = adviceDeduction(advisories);

  let score: number | null = null;
  if (applicable > 0) {
    const mustPoints = (MUST_POINTS * counts.passed) / applicable;
    const advicePoints = ADVICE_POINTS - advicePointsLost;
    score = Math.round(mustPoints + advicePoints);
    // The bands must mean something, so two caps guard them:
    //
    //   - 95–100 is reserved for runs that are MUST-clean AND complete. With
    //     a large enough denominator, one failure costs less than the 5-point
    //     advice budget (95·25/26 + 5 ≈ 96), which would rank a violating
    //     server above a clean-but-advised one. A failed or incomplete run
    //     therefore caps at 94: reading ≥95 always means every applicable
    //     MUST passed and was exercised.
    //   - 100 is reserved for the run with nothing left to say. Rounding
    //     alone would print 100 from 95·(n−1)/n + 5 once n ≈ 190.
    if (outcome !== "passed") {
      score = Math.min(score, MUST_POINTS - 1);
    } else if (advisories.length > 0) {
      score = Math.min(score, 99);
    }
  }

  return {
    score,
    outcome,
    applicable,
    ...counts,
    // Normalized rather than optional: every consumer can read `.pending`
    // without a `?? 0`, and a suite with no profile reports an honest zero.
    pending: counts.pending ?? 0,
    advisories,
    advicePointsLost,
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
  };
}

/**
 * Score one suite's checks. `advisories` is whatever advice channel the suite
 * has (readiness warnings, per-check warnings) — pass an empty array for a
 * suite without one.
 */
export function computeConformanceScore(
  checks: OutcomeCheckLike[],
  advisories: ScoredAdvisory[] = [],
  protocolVersion?: string,
  /**
   * The run's profile stamp, when it has one. Checks the profile does not score
   * are partitioned out BEFORE the counts and before the verdict — a pending
   * check must not move the number and must not fail the run. Absent ⇒ every
   * check is scored, which is the pre-profile arithmetic exactly.
   */
  profileStamp?: Pick<ConformanceProfileStamp, "pendingCheckIds">,
): ConformanceScore {
  const { scored, pending } = partitionByStamp(checks, profileStamp);
  const counts = {
    passed: scored.filter((check) => check.status === "passed").length,
    failed: scored.filter((check) => check.status === "failed").length,
    couldNotRun: scored.filter(isUnrunCheck).length,
    notApplicable: scored.filter(isInapplicableCheck).length,
    pending: pending.length,
  };
  // The outcome word comes from the shared verdict logic, never from the
  // arithmetic — the score annotates the verdict, it does not override it. It
  // reads the SCORED checks only, for the same reason the counts do.
  const { outcome } = decideConformanceOutcome(scored);
  return scoreFromCounts(counts, advisories, outcome, protocolVersion);
}

/**
 * One number across suites. Counts are summed and the score re-derived, so a
 * suite with many checks cannot drown one with few through averaging — and a
 * 0-for-9 OAuth run stays visible inside 30 protocol passes.
 *
 * Parts with nothing applicable (score null — e.g. OAuth against a public
 * server) contribute only their `notApplicable` tally: they are excluded from
 * the denominator by construction, not by filtering.
 */
export function pooledConformanceScore(
  parts: ConformanceScore[],
): ConformanceScore {
  const counts = {
    passed: sum(parts, (part) => part.passed),
    failed: sum(parts, (part) => part.failed),
    couldNotRun: sum(parts, (part) => part.couldNotRun),
    notApplicable: sum(parts, (part) => part.notApplicable),
    // `?? 0`: a part deserialized from a build that predates the pending
    // bucket carries no field, and reading it as NaN would poison the pool.
    pending: sum(parts, (part) => part.pending ?? 0),
  };
  const advisories = parts.flatMap((part) => part.advisories ?? []);

  // Worst-of, failure outranking incomplete — the same ordering the CLI exit
  // codes and suite reports use. Scoreless parts carry "passed" (nothing
  // unverified) and so never drag the pool.
  const outcomes = parts.map((part) => part.outcome);
  const outcome: ConformanceRunOutcome = outcomes.includes("failed")
    ? "failed"
    : outcomes.includes("incomplete")
      ? "incomplete"
      : "passed";

  // Strict: EVERY part must state the same version for the pool to claim one.
  // A part without a version is a run that established none, and labeling the
  // pool from the parts that did would overstate what was judged. Scoreless
  // parts (nothing applicable) constrain nothing — they judged nothing.
  const constraining = parts.filter((part) => part.applicable > 0);
  const versions = new Set(constraining.map((part) => part.protocolVersion));
  const protocolVersion =
    constraining.length > 0 && versions.size === 1
      ? [...versions][0]
      : undefined;

  return scoreFromCounts(counts, advisories, outcome, protocolVersion);
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

/** The one-line rendering every surface shares, so the wording cannot drift. */
export function describeConformanceScore(score: ConformanceScore): string {
  if (score.score === null) {
    return `not scored — 0 applicable checks (${score.notApplicable} not applicable)`;
  }
  const parts = [
    `${score.passed}/${score.applicable} applicable checks passed`,
  ];
  if (score.failed > 0) {
    parts.push(`${score.failed} failed`);
  }
  if (score.couldNotRun > 0) {
    parts.push(`${score.couldNotRun} could not run`);
  }
  if (score.advisories.length > 0) {
    parts.push(
      `${score.advisories.length} advisor${score.advisories.length === 1 ? "y" : "ies"} (−${score.advicePointsLost})`,
    );
  }
  // Named, never silent: a reader has to be able to tell "this run asked 36
  // questions and scored all of them" from "it asked 39 and scored 36".
  if ((score.pending ?? 0) > 0) {
    parts.push(`${score.pending} pending (unscored by this profile)`);
  }
  const version = score.protocolVersion ? ` [${score.protocolVersion}]` : "";
  return `${score.score}/100 — ${parts.join(", ")}${version}`;
}

/**
 * Protocol: checks verbatim; advice is the typed readiness channel, whose
 * `specStrength` already names the RFC 2119 tier.
 */
export function scoreFromProtocolResult(
  result: MCPConformanceResult,
): ConformanceScore {
  // `?? []`: a serialized result from an SDK that predates the readiness
  // channel scores fine — it just has no advice to deduct.
  return computeConformanceScore(
    result.checks,
    // `informational` advice is REPORTED but never costs points: it describes
    // behavior the spec explicitly permits, or rests on a non-normative
    // example. Deducting for it would contradict the readiness module's own
    // statement that such an observation is "reported and never scored", and
    // would dock a server for exercising a MAY it is entitled to.
    (result.readiness ?? [])
      .filter((warning) => warning.informational !== true)
      .map((warning) => ({
        id: warning.id,
        tier: warning.specStrength === "MAY" ? "may" : "should",
      })),
    result.protocolVersion,
    // Read off the RESULT, not the current build's manifest: a stored report
    // must score the same way it did when it was produced, even after this
    // build promotes some of its pending checks.
    result.profile,
  );
}

/**
 * Apps and Tasks share a check shape. Their advice channel is the per-check
 * free-string `warnings` — untyped, so each entry counts at the WEAKEST tier:
 * a string with no declared spec strength must not cost what a SHOULD does.
 */
function scoreFromWarningChecks(
  checks: Array<OutcomeCheckLike & { warnings?: string[] }>,
  protocolVersion?: string,
  profileStamp?: Pick<ConformanceProfileStamp, "pendingCheckIds">,
): ConformanceScore {
  // Warnings on a PENDING check must not cost points either: the check is not
  // being scored, and letting its advice deduct would move the number a
  // profile bump is supposed to gate.
  const { scored } = partitionByStamp(checks, profileStamp);
  return computeConformanceScore(
    checks,
    scored.flatMap((check) =>
      (check.warnings ?? []).map((_, index) => ({
        id: `${check.id}-warning-${index + 1}`,
        tier: "may" as const,
      })),
    ),
    protocolVersion,
    profileStamp,
  );
}

export function scoreFromAppsResult(
  result: MCPAppsConformanceResult,
): ConformanceScore {
  return scoreFromWarningChecks(result.checks, result.protocolVersion);
}

export function scoreFromTasksResult(
  result: MCPTasksConformanceResult,
): ConformanceScore {
  return scoreFromWarningChecks(
    result.checks,
    result.discovery.protocolVersion,
    // Read off the RESULT, not the current build's manifest, for the same
    // reason the protocol suite does: a stored report must score the way it did
    // when it was produced.
    result.profile,
  );
}

/**
 * OAuth is the outlier twice over.
 *
 * Its `"not-applicable"` outcome (the server serves without auth, which the
 * spec makes OPTIONAL) means the whole suite has nothing to score: null, zero
 * applicable, every step tallied as not-applicable. That is the mechanism by
 * which "a server without auth shouldn't deduct points" holds.
 *
 * Otherwise its steps adapt structurally (`step` → `id`) and are counted
 * directly: the score reads the evidence, not the verdict — even now that the
 * runner derives its verdict from the same shared vocabulary, the score's
 * arithmetic stays anchored to the steps themselves. `teachableMoments` are
 * explanations of failures already costed at MUST weight, never advisories.
 */
export function scoreFromOAuthResult(
  result: OAuthConformanceResult,
): ConformanceScore {
  if (result.outcome === "not-applicable") {
    return scoreFromCounts(
      {
        passed: 0,
        failed: 0,
        couldNotRun: 0,
        notApplicable: result.steps.length,
      },
      [],
      "passed",
      result.protocolVersion,
    );
  }

  const checks: OutcomeCheckLike[] = result.steps.map((step) => ({
    id: step.step,
    status: step.status,
    ...(step.skipReason ? { skipReason: step.skipReason } : {}),
    ...(step.error?.message ? { error: { message: step.error.message } } : {}),
  }));
  return computeConformanceScore(checks, [], result.protocolVersion);
}
