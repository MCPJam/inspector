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
import type {
  ActionableFinding,
  ActionableFindingEvidence,
  InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";

export type FindingView = "deterministic" | "ai";

export type ProseSource = "deterministic" | "ai" | "unknown";

export const PROSE_SOURCE_LABEL: Record<ProseSource, string> = {
  deterministic: "Standard guidance",
  ai: "AI explanation",
  unknown: "Source not recorded",
};

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

/** What the OBSERVATION rests on — measured, judged, or neither. */
export function basisLabel(
  provenance: InsightsFindingProvenance | null,
): { label: string; detail: string } | null {
  switch (provenance?.basis) {
    case "measured":
      return {
        label: "Measured",
        detail: "Counted from recorded contract-stage evidence.",
      };
    case "judged":
      return {
        label: "Judged",
        detail:
          "An evaluator's recorded verdict. A judgment, not a measured cause.",
      };
    case "mixed":
      return {
        label: "Measured + judged",
        detail:
          "Counts come from recorded stage evidence; some supporting text is an evaluator's verdict.",
      };
    case "unknown":
      return {
        label: "Unattributed",
        detail:
          "The evidence does not establish what failed — this is an investigation.",
      };
    default:
      return null;
  }
}

/**
 * How much the finding's CATEGORY is worth, in the reader's words.
 *
 * A category proved against the pinned schema and one matched from an error
 * message are not the same claim, and a page that shows them identically
 * invites a reader to act on the weaker one as if it were the stronger.
 * Producer-owned, like every other label here — never sniffed from the text.
 */
export function classificationLine(
  provenance: InsightsFindingProvenance | null,
): string | null {
  switch (provenance?.classificationBasis) {
    case "schema":
      return "Category proved against the tool's pinned input schema.";
    case "error_code":
      return "Category read from the standardized error code the server returned.";
    case "error_text":
      return "Category matched from the wording of the server's error message — a reading, not a proof.";
    default:
      return null;
  }
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

/** Human label for an evidence row's kind. */
export const EVIDENCE_KIND_LABEL: Record<
  ActionableFindingEvidence["kind"],
  string
> = {
  tool_error: "Tool error",
  transcript: "Transcript",
  feedback: "Feedback",
  judge: "Recorded judge evidence",
  contrast: "Contrasting success",
};

/**
 * Whether a finding is an INVESTIGATION rather than a fix.
 *
 * Distinct from `isServerReady`: a finding can name real work (an agent
 * change, a test change) without being a server repair. This is the predicate
 * the wording keys on — "What to investigate" vs "What to change".
 */
export function isInvestigation(finding: ActionableFinding): boolean {
  return finding.actionability !== "ready";
}
