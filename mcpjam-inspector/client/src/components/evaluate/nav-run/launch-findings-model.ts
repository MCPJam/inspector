/**
 * One findings list for a whole launch. Each member run's findings are built
 * on their own; the same break on two models is one piece of work, so
 * findings merge by stage and reason (as the Test run page merges its
 * failure groups) and their counts add up.
 */
import {
  sortFindingsForDisplay,
  type ActionableFinding,
  type InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";

export type RunFindings = {
  findings: readonly ActionableFinding[];
  provenance: readonly InsightsFindingProvenance[];
  /** The run's iteration count: the merged findings' denominator. */
  iterationCount: number;
};

const COUNTED = /^\d+ of \d+ (iterations?|sessions?)\b/;

function keyOf(
  finding: ActionableFinding,
  provenance: InsightsFindingProvenance | undefined,
): string {
  return provenance?.stage
    ? `stage:${provenance.stage}:${provenance.reason ?? "none"}`
    : `signal:${finding.signalFingerprint}`;
}

/** "3 of 12 iterations …" restated over the launch: "3 of 24 iterations …". */
function restate(observed: string, count: number, total: number): string {
  const match = observed.match(COUNTED);
  if (!match) return observed;
  const unit = match[1].replace(/s$/, "");
  return observed.replace(
    COUNTED,
    `${count} of ${total} ${unit}${total === 1 ? "" : "s"}`,
  );
}

export function mergeLaunchFindings(
  parts: readonly RunFindings[],
): ActionableFinding[] {
  const total = parts.reduce((sum, part) => sum + part.iterationCount, 0);
  const merged = new Map<string, ActionableFinding>();
  for (const part of parts) {
    const provenance = new Map(
      part.provenance.map((item) => [item.candidateId, item]),
    );
    for (const finding of sortFindingsForDisplay([...part.findings])) {
      const key = keyOf(finding, provenance.get(finding.id));
      const existing = merged.get(key);
      if (existing) {
        existing.affected.count += finding.affected.count;
        existing.evidence.push(...finding.evidence);
        continue;
      }
      merged.set(key, {
        ...finding,
        affected: { ...finding.affected },
        evidence: [...finding.evidence],
      });
    }
  }
  return sortFindingsForDisplay(
    [...merged.values()].map((finding) => {
      const launchTotal =
        finding.affected.unit === "iterations" && total > 0
          ? total
          : finding.affected.total;
      return {
        ...finding,
        affected: { ...finding.affected, total: launchTotal },
        observed: restate(
          finding.observed,
          finding.affected.count,
          launchTotal,
        ),
      };
    }),
  );
}
