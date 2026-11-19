import type { EvalIteration } from "@/components/evals/types";
import type { ScorecardRow } from "./case-scorecard-model";
import type { JoinedScorecardRow, TrialRowResult } from "./trial-results";

type StoredOutcome = {
  id: string;
  label: string;
  role: "required" | "advisory";
  status: "scored" | "error";
  pass?: boolean;
  reason?: string;
  logs?: string;
};

function outcomesOf(iteration: EvalIteration | null): StoredOutcome[] {
  const raw = (iteration?.metadata as Record<string, unknown> | undefined)
    ?.codeEvaluatorResults;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is StoredOutcome =>
      !!o &&
      typeof o === "object" &&
      typeof (o as StoredOutcome).id === "string" &&
      typeof (o as StoredOutcome).label === "string",
  );
}

/** Logs ride under the reason, clipped, so a failing check shows what it printed. */
function reasonWithLogs(o: StoredOutcome): string {
  const reason = o.reason?.trim() || "No reason given.";
  const logs = o.logs?.trim();
  if (!logs) return reason;
  return `${reason}\nLogs: ${logs.length > 600 ? `${logs.slice(0, 600)}…` : logs}`;
}

/**
 * The code evaluators this trial ran, from `metadata.codeEvaluatorResults`,
 * which the runner writes on every trial whatever the grading mode. An error
 * (no sandbox, a throw, a timeout) is its own state, never a fail.
 */
export function codeEvaluatorTrialRows(
  iteration: EvalIteration | null,
): JoinedScorecardRow[] {
  return outcomesOf(iteration).map((o) => {
    const row: ScorecardRow = {
      key: `code:${o.id}`,
      stage: "userValue",
      provenance: "code",
      label: o.label,
      kindLabel: "Code",
      role: o.role === "required" ? "required" : "advisory",
      roleLock: "judge",
      editable: false,
      tooltip: "Code this suite wrote, run on the trial in a sandbox.",
      join: { kind: "judge", slot: "rubricChecks", scorerId: `code:${o.id}` },
    };
    const reason = reasonWithLogs(o);
    const result: TrialRowResult =
      o.status === "error"
        ? { state: "error", source: "scoreRow", reason }
        : { state: o.pass ? "passed" : "failed", source: "scoreRow", reason };
    return { ...row, result };
  });
}
