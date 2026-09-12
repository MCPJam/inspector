/**
 * "We could not measure this" — spelled ONE way.
 *
 * The eval pipeline knows four separate facts that all mean the same thing to
 * a person reading a result, and says each of them differently:
 *
 *   - `traceAbsent` / `traceLacksSpanChannel` (`finalize-iteration.ts`) —
 *     nothing was captured, or a transcript exists with no span channel.
 *   - `merge.completeness.status` — the harness-evidence merge's own word for
 *     how much of the run it could reconstruct.
 *   - `judgeAbsenceStatus` (`score-rows.ts`) — the judge produced no verdict,
 *     and why.
 *   - and now `no_agent_activity` — nothing ran at all.
 *
 * Four vocabularies for one question means nobody can answer "was this result
 * measured?" without knowing all four, and a surface that checks three of them
 * reports a confident verdict on the fourth.
 *
 * THIS NEVER FEEDS `passed`, and that separation is the point. Whether an
 * iteration passed is decided by `buildEvalIterationVerdict` and by the score
 * rows; this is a DESCRIPTION of how much the result rests on, persisted as
 * `metadata.evidenceInsufficiency` beside the verdict rather than folded into
 * it. A reader can then tell a genuine pass from a pass nothing contradicted.
 */
import type { AgentActivityAssessment } from "./agent-activity.js";

/** Every reason the pipeline can give for not having measured something. */
export type EvidenceInsufficiencyReason =
  /** Nothing was captured at all — a setup failure, a lifecycle stop. */
  | "traceAbsent"
  /**
   * A transcript exists and carries no spans.
   *
   * NOT the same as `traceAbsent`, and collapsing the two is precisely how a
   * run with every tool call failing passes vacuously: this executor simply
   * never reports what happened.
   */
  | "traceLacksSpanChannel"
  /** The harness-evidence merge could not reconstruct the whole run. */
  | "harnessEvidenceIncomplete"
  /** The judge produced no verdict. */
  | "judgeAbsent"
  /** Nothing ran. @see assessAgentActivity */
  | "noAgentActivity";

export interface EvidenceInsufficiency {
  insufficient: boolean;
  /** Every reason that applies, in a stable order for a diffable record. */
  reasons: EvidenceInsufficiencyReason[];
}

export interface EvidenceInsufficiencyInput {
  traceAbsent?: boolean;
  traceLacksSpanChannel?: boolean;
  /** The merge's own completeness verdict, when one was computed. */
  harnessCompleteness?: { status?: string } | undefined;
  /** Whether the judge produced a verdict at all. */
  judgeAbsence?: { absent?: boolean } | undefined;
  agentActivity?: AgentActivityAssessment | undefined;
}

/**
 * Collect every reason this iteration's result rests on less than a full
 * measurement.
 *
 * ORDER IS FIXED — most fundamental first — so two runs of the same iteration
 * produce the same list and a diff of persisted metadata is readable. An empty
 * list is the ordinary case and means the result was measured, not that it
 * passed.
 */
export function deriveEvidenceInsufficiency(
  input: EvidenceInsufficiencyInput,
): EvidenceInsufficiency {
  const reasons: EvidenceInsufficiencyReason[] = [];
  if (input.traceAbsent) reasons.push("traceAbsent");
  // Mutually exclusive with `traceAbsent` at the producer, but not assumed to
  // be: this reads whatever it is handed, and a caller that set both is
  // describing something worth seeing both halves of.
  if (input.traceLacksSpanChannel) reasons.push("traceLacksSpanChannel");
  // ANY status but `complete` counts, including one this build does not
  // recognise: a new completeness status must not read as "fully measured"
  // simply because nothing here was taught about it.
  const completeness = input.harnessCompleteness?.status;
  if (completeness !== undefined && completeness !== "complete") {
    reasons.push("harnessEvidenceIncomplete");
  }
  if (input.judgeAbsence?.absent) reasons.push("judgeAbsent");
  if (input.agentActivity?.status === "no_agent_activity") {
    reasons.push("noAgentActivity");
  }
  return { insufficient: reasons.length > 0, reasons };
}
