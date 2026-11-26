import type { Predicate } from "@mcpjam/sdk/predicates";
import { Library } from "lucide-react";
import type { TrialRowResult } from "@/components/evaluate/case-scorecard/trial-results";
import type { ScorerUiRole } from "../suite-scorer-table-model";
import { useEvaluatorLibraryEnabled } from "./evaluator-library-flag";
import { findLibraryEvaluator } from "./library-catalog";
import { evaluatorIdForQuestionKey } from "./library-suite-edits";
import { ScorecardEvaluatorCard } from "./scorecard-evaluator-card";
import type { VerdictStatus } from "./verdict-pill";

/** The parts of a joined scorecard row this summary reads. */
export type SummaryRow = {
  key: string;
  label: string;
  role: ScorerUiRole;
  predicate?: Predicate;
  /** Rubric-check rows: the `q:<id>` key, which names a library question. */
  rubricCheck?: { key: string };
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
 * because a crashed check says nothing about the agent; a failed Required
 * check fails the evaluator, and an Advisory miss fails it only when no
 * Required check applied; Not applicable is never a pass.
 */
export function evaluatorStatus(
  checks: readonly { role: ScorerUiRole; status: VerdictStatus }[],
): VerdictStatus {
  const statuses = checks.map((c) => c.status);
  if (statuses.includes("error")) return "error";
  // Only checks that measured something can decide. Required ones decide
  // when any applied; otherwise the evaluator is judged by the checks it has
  // left (a model question, or an evaluator whose Required check the suite
  // already had), so a Not applicable Required check never lends its pass
  // to an Advisory miss.
  const applicable = checks.filter(
    (c) => c.status !== "not_applicable" && c.status !== "skipped",
  );
  const required = applicable.filter((c) => c.role === "required");
  const deciding = required.length > 0 ? required : applicable;
  if (deciding.some((c) => c.status === "failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (deciding.some((c) => c.status === "passed" || c.status === "partial"))
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
    const id =
      row.predicate?.evaluator?.id ??
      evaluatorIdForQuestionKey(row.rubricCheck?.key);
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
