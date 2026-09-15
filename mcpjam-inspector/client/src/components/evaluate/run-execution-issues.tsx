import { AlertTriangle } from "lucide-react";
import { sanitizeTraceErrorMessage } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { isMCPJamModelLimitError } from "@/lib/mcpjam-limit";
import type { EvalIteration } from "../evals/types";

const ISSUE_COPY = {
  model_limit: {
    title: "MCPJam model limit reached",
    nextStep:
      "Wait for the model allowance to reset, or use your own model API key (BYOK), then rerun.",
  },
  worker_lost: {
    title: "Worker heartbeat lost",
    nextStep:
      "Rerun the affected cases. If this happens again, check the worker's connection and logs.",
  },
  model_error: {
    title: "Model request failed",
    nextStep:
      "Check the recorded provider error, resolve it, then rerun the affected cases.",
  },
  setup_error: {
    title: "Run setup failed",
    nextStep:
      "Check the recorded setup error, resolve it, then rerun the affected cases.",
  },
} as const;

type IssueKind = keyof typeof ISSUE_COPY;
export type RunExecutionIssueSummary = {
  total: number;
  affected: number;
  complete: boolean;
  noModelOrToolActivity: boolean;
  groups: Array<{ kind: IssueKind; iterations: EvalIteration[] }>;
};

function issueKind(iteration: EvalIteration): IssueKind | null {
  // A recorded error on an in-flight or eventually successful attempt is not
  // evidence that this iteration failed to execute.
  if (
    !["completed", "failed", "timed_out", "setup_failed"].includes(
      iteration.status,
    ) ||
    iteration.result === "passed"
  )
    return null;
  const metadata = iteration.metadata;
  if (metadata?.stopReason === "stale_worker") return "worker_lost";
  if (!iteration.error) return null;
  const modelError = metadata?.stageStepErrorSource === "model";
  const setupError =
    iteration.status === "setup_failed" ||
    metadata?.failureCategory === "setup";
  if (
    (modelError || setupError) &&
    isMCPJamModelLimitError({ message: iteration.error })
  ) {
    return "model_limit";
  }
  if (modelError) return "model_error";
  if (setupError) return "setup_error";
  return null;
}

/** Summarize recorded execution errors, independently of the findings build. */
export function summarizeRunExecutionIssues({
  suiteRunId,
  iterations,
  expectedTotal,
}: {
  suiteRunId: string;
  iterations: readonly EvalIteration[];
  expectedTotal?: number;
}): RunExecutionIssueSummary | null {
  // Both callers can hold other runs. Deduplication also prevents overlapping
  // iteration pages from inflating the affected count.
  const rows = [
    ...new Map(
      iterations
        .filter((row) => row.suiteRunId === suiteRunId)
        .map((row) => [row._id, row]),
    ).values(),
  ];
  const total = Math.max(rows.length, expectedTotal ?? 0);
  const byKind = new Map<IssueKind, EvalIteration[]>();
  for (const row of rows) {
    const kind = issueKind(row);
    if (kind) {
      const group = byKind.get(kind) ?? [];
      group.push(row);
      byKind.set(kind, group);
    }
  }
  if (byKind.size === 0) return null;
  const groups = (Object.keys(ISSUE_COPY) as IssueKind[]).flatMap((kind) => {
    const affected = byKind.get(kind);
    return affected ? [{ kind, iterations: affected }] : [];
  });
  const complete = rows.length === total;
  return {
    total,
    affected: groups.reduce((sum, group) => sum + group.iterations.length, 0),
    complete,
    noModelOrToolActivity:
      complete &&
      rows.every(
        (row) =>
          row.tokensUsed === 0 &&
          Array.isArray(row.actualToolCalls) &&
          row.actualToolCalls.length === 0,
      ),
    groups,
  };
}

export function RunExecutionIssues({
  summary,
  onOpenIteration,
}: {
  summary: RunExecutionIssueSummary;
  onOpenIteration?: (iterationId: string) => void;
}) {
  return (
    <section
      aria-label="Recorded execution errors"
      className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-foreground"
      data-testid="run-execution-issues"
    >
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        {summary.affected === summary.total
          ? `Execution errors in all ${summary.total} iterations`
          : `Execution errors in ${summary.affected} of ${summary.total} iterations`}
      </h4>
      {summary.noModelOrToolActivity ? (
        <p className="mt-1 text-sm">
          Zero model tokens and zero tool calls were recorded. Resolve the
          execution errors and rerun to measure model and tool behavior.
        </p>
      ) : null}
      {!summary.complete ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Some iteration records are still missing; more execution errors may
          exist.
        </p>
      ) : null}
      <ul className="mt-3 space-y-3">
        {summary.groups.map((group) => (
          <li key={group.kind}>
            <p className="text-sm font-medium">
              {ISSUE_COPY[group.kind].title} · {group.iterations.length} of{" "}
              {summary.total} iterations
            </p>
            <p className="mt-1 text-sm">{ISSUE_COPY[group.kind].nextStep}</p>
            {group.iterations[0].error ? (
              <p className="mt-1 break-words text-xs text-muted-foreground">
                Recorded error:{" "}
                {sanitizeTraceErrorMessage(group.iterations[0].error, {
                  maxLength: 500,
                })}
              </p>
            ) : null}
            <details className="mt-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-2">
              <summary className="cursor-pointer text-xs font-medium">
                Recorded error and affected iterations (
                {group.iterations.length})
              </summary>
              <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                {group.iterations.map((iteration) => (
                  <li
                    key={iteration._id}
                    className="border-t border-border/40 pt-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        {iteration.testCaseSnapshot?.title ?? "Test case"} ·
                        Iteration {iteration.iterationNumber}
                      </span>
                      {onOpenIteration && iteration.testCaseId ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => onOpenIteration(iteration._id)}
                        >
                          Open iteration
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                      {iteration.error
                        ? sanitizeTraceErrorMessage(iteration.error, {
                            maxLength: 500,
                          })
                        : "Recorded stop reason: stale_worker. No error message was stored."}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
