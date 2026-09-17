/**
 * What a finding's words are worth — the labelling rules, in one place.
 *
 * Three sources of prose must stay distinguishable on screen, because a
 * reader's next action depends on which one they are reading:
 *
 *  - STANDARD GUIDANCE: the deterministic fallback the backend finalizer
 *    writes when no model row matched. It is a safe next step, not an
 *    analysis, and labelling it as AI output would be a lie about where it
 *    came from.
 *  - AI EXPLANATION: prose a model actually wrote for this exact candidate id.
 *  - RECORDED JUDGE EVIDENCE: an evaluator's own explanation, replayed. It is
 *    a judgment that was made and stored, not something we generated now, and
 *    not a measured root cause.
 *
 * Every label here is derived from PRODUCER-OWNED facts (`proseOrigin`,
 * `basis`, the evidence `kind`) and never from sniffing the text. Two reasons:
 * a model that happens to write the fallback sentence would be mislabelled,
 * and the fallback sentence is free to change.
 */
import type { InsightsFindingProvenance } from "@/lib/insights-envelope-api";

/** Absent on older results; a missing history is never described as a new issue. */
export function recurrenceLine(
  provenance: InsightsFindingProvenance | null,
): string | null {
  const history = provenance?.recurrence;
  if (
    !history ||
    !Number.isInteger(history.occurrences) ||
    !Number.isInteger(history.analyzedRuns) ||
    history.occurrences < 1 ||
    history.analyzedRuns < history.occurrences ||
    !Number.isFinite(history.firstSeenAt)
  )
    return null;
  const date = new Date(history.firstSeenAt);
  if (Number.isNaN(date.getTime())) return null;
  const first = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `Seen in ${history.occurrences} of this suite’s last ${history.analyzedRuns} analyzed runs, first on ${first}.`;
}

export type FindingView = "deterministic" | "ai";

export type ProseSource = "deterministic" | "ai" | "unknown";

/**
 * The origin of one prose field.
 *
 * In the deterministic view the answer is fixed by construction — nothing a
 * model wrote is on screen — so the provenance record is not even consulted.
 */
export function proseSourceOf(
  view: FindingView,
  provenance: InsightsFindingProvenance | null,
  field: "title" | "rootCause" | "recommendation" | "acceptanceCriteria",
): ProseSource {
  if (view === "deterministic") return "deterministic";
  const origin = provenance?.proseOrigin?.[field];
  return origin ?? "unknown";
}

/** The caveat a sampled mechanism carries, if any. */
export function mechanismCaveat(
  provenance: InsightsFindingProvenance | null,
): string | null {
  if (!provenance) return null;
  if (provenance.mechanismBasis !== "sampled") return null;
  return (
    provenance.populationCaveat ??
    "Tool identity came from inspected exemplars only; no run-wide rate is claimed."
  );
}

/**
 * How much of an AI mechanism's count was verified trial by trial.
 *
 * Null when the backend sent no verification (older backend, or a
 * deterministic group) or when every proposed trial was confirmed: the
 * count then already says everything. Otherwise the reader learns that the
 * count excludes the trials that could not be verified.
 */
export function verificationLine(
  provenance: InsightsFindingProvenance | null,
): string | null {
  const verification = provenance?.verification;
  if (!verification) return null;
  const unresolved =
    (verification.unsupported ?? 0) +
    (verification.inconclusive ?? 0) +
    (verification.unchecked ?? 0);
  if (unresolved === 0) return null;
  const parts = [
    verification.unsupported > 0
      ? `${verification.unsupported} did not show it`
      : null,
    verification.inconclusive > 0
      ? `${verification.inconclusive} could not be verified`
      : null,
    verification.unchecked > 0 ? `${verification.unchecked} not checked` : null,
  ].filter(Boolean);
  return `Verified ${verification.confirmed} of ${
    verification.proposed
  } proposed trials (${parts.join(", ")}); only verified trials are counted.`;
}

/** A one-line rendering of recorded judge coverage. */
export function judgeCoverageLine(
  provenance: InsightsFindingProvenance | null,
): string | null {
  const coverage = provenance?.judgeCoverage;
  if (!coverage) return null;
  // "graded 0 of 0 eligible" is noise, not coverage: it says the evaluator was
  // never asked, which the finding's own sentence already says better.
  if (coverage.eligible === 0) return null;
  // The envelope arrives from Convex as a cast, not a validated value, so a
  // backend at a different version can omit this. Absent counts mean the
  // breakdown is dropped and "graded X of Y eligible" still renders — that
  // sentence is the useful half, and it does not depend on these.
  const nonGraded = coverage.nonGraded ?? {
    pending: 0,
    skipped: 0,
    errored: 0,
  };
  const outstanding = [
    nonGraded.pending > 0 ? `${nonGraded.pending} pending` : null,
    nonGraded.skipped > 0 ? `${nonGraded.skipped} skipped` : null,
    nonGraded.errored > 0 ? `${nonGraded.errored} errored` : null,
  ].filter(Boolean);
  return [
    `${coverage.evaluatorLabel}: graded ${coverage.graded} of ${coverage.eligible} eligible`,
    outstanding.length > 0 ? ` (${outstanding.join(", ")})` : "",
  ].join("");
}
