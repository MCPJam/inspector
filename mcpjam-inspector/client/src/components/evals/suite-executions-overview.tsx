import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime, getIterationRecencyTimestamp } from "./helpers";
import { computeIterationResult } from "./pass-criteria";
import type { EvalCase, EvalIteration } from "./types";

function getExecutionCaseTitle(
  iteration: EvalIteration,
  caseById: Map<string, EvalCase>,
) {
  if (iteration.testCaseId) {
    const testCase = caseById.get(iteration.testCaseId);
    if (testCase?.title) {
      return testCase.title;
    }
  }
  return iteration.testCaseSnapshot?.title || "Untitled test case";
}

function getResultLabel(iteration: EvalIteration) {
  const result = computeIterationResult(iteration);
  if (result === "pending") {
    return iteration.status === "running" ? "Running" : "Pending";
  }
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function getResultBadgeClass(iteration: EvalIteration) {
  const result = computeIterationResult(iteration);
  if (result === "passed") {
    return "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300";
  }
  if (result === "failed") {
    return "bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300";
  }
  if (result === "cancelled") {
    return "bg-muted text-muted-foreground";
  }
  return "bg-amber-500/15 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300";
}

export function SuiteExecutionsOverview({
  cases,
  allIterations,
  onOpenIteration,
}: {
  cases: EvalCase[];
  allIterations: EvalIteration[];
  onOpenIteration: (iteration: EvalIteration) => void;
}) {
  const caseById = useMemo(
    () => new Map(cases.map((testCase) => [testCase._id, testCase] as const)),
    [cases],
  );

  const sortedIterations = useMemo(() => {
    const deduped = new Map<string, EvalIteration>();
    for (const iteration of allIterations) {
      if (!iteration?._id) {
        continue;
      }
      if (iteration.testCaseId && !caseById.has(iteration.testCaseId)) {
        continue;
      }
      deduped.set(iteration._id, iteration);
    }
    return Array.from(deduped.values()).sort(
      (a, b) =>
        getIterationRecencyTimestamp(b) - getIterationRecencyTimestamp(a),
    );
  }, [allIterations, caseById]);

  return (
    <div className="flex max-h-[600px] flex-col rounded-xl border bg-card text-card-foreground">
      {sortedIterations.length > 0 ? (
        <div className="flex w-full items-center gap-3 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
          <div className="min-w-[120px] flex-1">Test case</div>
          <div className="w-24 shrink-0 text-right">Result</div>
          <div className="w-44 shrink-0 text-right">Timestamp</div>
          <span className="w-4 shrink-0" aria-hidden />
        </div>
      ) : null}

      <div className="divide-y overflow-y-auto">
        {sortedIterations.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No executions found.
          </div>
        ) : (
          sortedIterations.map((iteration) => {
            const timestamp = getIterationRecencyTimestamp(iteration);
            const timestampLabel = formatTime(timestamp || undefined);
            const caseTitle = getExecutionCaseTitle(iteration, caseById);
            const openable = Boolean(
              iteration.testCaseId || iteration.suiteRunId,
            );
            const rowContent = (
              <>
                <div className="min-w-[120px] flex-1 text-left">
                  <div className="truncate text-xs font-medium">
                    {caseTitle}
                  </div>
                </div>
                <div className="flex w-24 shrink-0 justify-end">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                      getResultBadgeClass(iteration),
                    )}
                  >
                    {getResultLabel(iteration)}
                  </span>
                </div>
                <div
                  className="w-44 shrink-0 truncate text-right text-xs tabular-nums text-muted-foreground"
                  title={timestampLabel}
                >
                  {timestampLabel}
                </div>
                <span className="flex w-4 shrink-0 justify-end">
                  {openable ? (
                    <ChevronRight
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden
                    />
                  ) : null}
                </span>
              </>
            );

            if (!openable) {
              return (
                <div
                  key={iteration._id}
                  data-testid={`suite-execution-row-${iteration._id}`}
                  className="flex w-full items-center gap-3 px-4 py-2.5"
                >
                  {rowContent}
                </div>
              );
            }

            return (
              <button
                key={iteration._id}
                type="button"
                data-testid={`suite-execution-row-${iteration._id}`}
                className="flex w-full items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                aria-label={`Open execution for ${caseTitle} from ${timestampLabel}`}
                onClick={() => onOpenIteration(iteration)}
              >
                {rowContent}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
