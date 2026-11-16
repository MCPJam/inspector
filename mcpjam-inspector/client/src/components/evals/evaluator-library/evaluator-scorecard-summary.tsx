import type { Predicate } from "@mcpjam/sdk/predicates";
import { Library } from "lucide-react";
import type { TrialRowResult } from "@/components/evaluate/case-scorecard/trial-results";
import type { ScorerUiRole } from "../suite-scorer-table-model";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";
import { ScorecardEvaluatorCard } from "./scorecard-evaluator-card";
import type { VerdictStatus } from "./verdict-pill";

/** The parts of a joined scorecard row this summary reads. */
export type SummaryRow = {
  key: string;
  label: string;
  role: ScorerUiRole;
  predicate?: Predicate;
  result: TrialRowResult;
};

const STATUS: Record<TrialRowResult["state"], VerdictStatus> = {
  passed: "passed",
  failed: "failed",
  uncertain: "partial",
  error: "error",
  skipped: "skipped",
  notApplicable: "not_applicable",
  pending: "running",
  notMeasured: "skipped",
};

/**
 * One evaluator's verdict from its checks: an error outranks a failure,
 * because a crashed check says nothing about the agent; only a failed
 * Required check fails the evaluator; Not applicable is never a pass.
 */
export function evaluatorStatus(
  checks: readonly { role: ScorerUiRole; status: VerdictStatus }[],
): VerdictStatus {
  const statuses = checks.map((c) => c.status);
  if (statuses.includes("error")) return "error";
  if (checks.some((c) => c.status === "failed" && c.role === "required"))
    return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.some((s) => s === "passed" || s === "partial" || s === "failed"))
    return "passed";
  if (statuses.every((s) => s === "skipped")) return "skipped";
  return "not_applicable";
}

/**
 * Per-evaluator cards above a trial's stage sections, for checks added from
 * the library. The stage sections below still list every check, so this only
 * answers "which evaluators passed" at a glance.
 */
export function EvaluatorScorecardSummary({
  rows,
}: {
  rows: readonly SummaryRow[];
}) {
  const enabled = useEvaluatorLibraryEnabled();
  if (!enabled) return null;
  const byEvaluator = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const id = row.predicate?.evaluator?.id;
    if (!id) continue;
    byEvaluator.set(id, [...(byEvaluator.get(id) ?? []), row]);
  }
  if (byEvaluator.size === 0) return null;
  return (
    <section aria-label="Library evaluators" className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">
        Library evaluators
      </h3>
      {[...byEvaluator].map(([id, evaluatorRows]) => {
        const entry = findLibraryEvaluator(id);
        const checks = evaluatorRows.map((row) => ({
          id: row.key,
          label: row.label,
          role: row.role,
          status: STATUS[row.result.state],
          evidence: "reason" in row.result ? row.result.reason : undefined,
        }));
        return (
          <ScorecardEvaluatorCard
            key={id}
            name={entry?.name ?? id}
            icon={entry?.icon ?? Library}
            origin="library"
            status={evaluatorStatus(checks)}
            checks={checks}
          />
        );
      })}
    </section>
  );
}
