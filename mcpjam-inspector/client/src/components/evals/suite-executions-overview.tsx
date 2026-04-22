import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime, getIterationRecencyTimestamp } from "./helpers";
import {
  getIterationResultBadgeClass,
  getIterationResultDisplayLabel,
} from "./iteration-result-presentation";
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

export function SuiteExecutionsOverview({
  cases,
  allIterations,
  onOpenIteration,
  className,
  listClassName,
}: {
  cases: EvalCase[];
  allIterations: EvalIteration[];
  onOpenIteration: (iteration: EvalIteration) => void;
  /** Merged onto the outer card (e.g. flex-1 min-h-0 for full-height layouts). */
  className?: string;
  /** Merged onto the scrollable list region. */
  listClassName?: string;
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
    <div
      className={cn(
        "flex max-h-[600px] flex-col rounded-xl border bg-card text-card-foreground",
        className,
      )}
    >
      {sortedIterations.length > 0 ? (
        <div className="flex w-full items-center gap-3 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
          <div className="min-w-[120px] flex-1">Test case</div>
          <div className="w-24 shrink-0 text-right">Result</div>
          <div className="w-44 shrink-0 text-right">Timestamp</div>
          <span className="w-4 shrink-0" aria-hidden />
        </div>
      ) : null}

      <div className={cn("divide-y overflow-y-auto", listClassName)}>
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
                      getIterationResultBadgeClass(iteration),
                    )}
                  >
                    {getIterationResultDisplayLabel(iteration)}
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
