import type { Predicate } from "@mcpjam/sdk/predicates";
import { Library } from "lucide-react";
import type { TrialRowResult } from "@/components/evaluate/case-scorecard/trial-results";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
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
  /** Rubric-check rows: the `q:<id>` key, which names a library question. */
  rubricCheck?: { key: string };
  customJudge?: { evaluatorId?: string };
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
 * The library evaluator a rubric-check row came from. A stored row keeps only
 * its `q:<id>` key, so the evaluator is read off the tag of the question with
 * that id in the trial's question list; an untagged question is the author's
 * own, even when its id matches a library question's.
 */
export function evaluatorIdForQuestionKey(
  key: string | undefined,
  questions: readonly RubricCheckQuestion[],
): string | undefined {
  if (!key?.startsWith("q:")) return undefined;
  const id = key.slice(2);
  const tag = questions.find((q) => q.id === id)?.evaluator?.id;
  return tag && findLibraryEvaluator(tag) ? tag : undefined;
}

/** Required checks decide when applicable. Advisory checks are the fallback. */
export function evaluatorStatus(
  checks: readonly { role: ScorerUiRole; status: VerdictStatus }[],
): VerdictStatus {
  const statuses = checks.map((c) => c.status);
  const applicable = checks.filter(
    (c) => c.status !== "not_applicable" && c.status !== "skipped",
  );
  const required = applicable.filter((c) => c.role === "required");
  const deciding = required.length > 0 ? required : applicable;
  if (deciding.some((c) => c.status === "error")) return "error";
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
  questions = [],
}: {
  rows: readonly SummaryRow[];
  /** The rubric-check questions the trial was asked, with their tags. */
  questions?: readonly RubricCheckQuestion[];
}) {
  const enabled = useEvaluatorLibraryEnabled();
  if (!enabled) return null;
  const byEvaluator = new Map<string, SummaryRow[]>();
  for (const row of rows) {
    const id =
      row.predicate?.evaluator?.id ??
      evaluatorIdForQuestionKey(row.rubricCheck?.key, questions) ??
      row.customJudge?.evaluatorId;
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
