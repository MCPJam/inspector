/**
 * What a conformance score reads as, in one place. ScoreHeadline, the
 * score.mcpjam.com results page and the share card all name the verdict
 * through this, so the app, the results page and a shared card can't
 * disagree about what a run means.
 */

export type ConformanceVerdictTone = "ok" | "warn" | "bad";

export type ConformanceVerdict = {
  label: string;
  tone: ConformanceVerdictTone;
};

/**
 * The verdict for a scored run. Advice costs no points, but a passing run
 * with advice says so rather than reading as plain conformant. Only a
 * recorded pass reads as passing: a missing or unknown outcome is incomplete.
 */
export function conformanceVerdict(
  outcome: string | null | undefined,
  advisoryCount: number,
): ConformanceVerdict {
  if (outcome === "failed") return { label: "Not conformant", tone: "bad" };
  if (outcome !== "passed") return { label: "Incomplete run", tone: "warn" };
  return advisoryCount > 0
    ? { label: "Conformant, with advice", tone: "ok" }
    : { label: "Conformant", tone: "ok" };
}
