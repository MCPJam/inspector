import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime, getIterationRecencyTimestamp } from "./helpers";
import { computeIterationResult } from "./pass-criteria";

type ComputedIterationResult = ReturnType<typeof computeIterationResult>;
import {
  getIterationResultBadgeClass,
  getIterationResultDisplayLabel,
} from "./iteration-result-presentation";
import type { EvalCase, EvalIteration } from "./types";

type ExecutionFilter = "all" | "passed" | "failed" | "other";

function executionFilterMatches(
  filter: ExecutionFilter,
  computed: ComputedIterationResult,
): boolean {
  if (filter === "all") return true;
  if (filter === "passed") return computed === "passed";
  if (filter === "failed") return computed === "failed";
  return computed !== "passed" && computed !== "failed";
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

  const [filter, setFilter] = useState<ExecutionFilter>("all");
  const [search, setSearch] = useState("");

  /*
   * Per-iteration result + title cached once; the filter strip and the
   * aggregate strip both need them, and computing twice on every keystroke
   * adds up on suites with hundreds of historical iterations.
   */
  const annotated = useMemo(
    () =>
      sortedIterations.map((iteration) => ({
        iteration,
        result: computeIterationResult(iteration),
        title: getExecutionCaseTitle(iteration, caseById),
      })),
    [sortedIterations, caseById],
  );

  const searchLower = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      annotated.filter((entry) => {
        if (!executionFilterMatches(filter, entry.result)) return false;
        if (
          searchLower &&
          !entry.title.toLowerCase().includes(searchLower)
        ) {
          return false;
        }
        return true;
      }),
    [annotated, filter, searchLower],
  );

  /*
   * "Today" aggregate strip — answers the only ambient question this
   * cross-suite firehose can usefully answer ("am I getting more failures
   * than usual?"). Anything finer-grained belongs in the per-suite view.
   */
  const todayStats = useMemo(() => {
    const cutoff = Date.now() - ONE_DAY_MS;
    let total = 0;
    let passed = 0;
    let failed = 0;
    for (const entry of annotated) {
      const ts = getIterationRecencyTimestamp(entry.iteration);
      if (!ts || ts < cutoff) continue;
      total += 1;
      if (entry.result === "passed") passed += 1;
      else if (entry.result === "failed") failed += 1;
    }
    const passRate = total > 0 ? Math.round((passed / total) * 100) : null;
    return { total, passed, failed, passRate };
  }, [annotated]);

  return (
    <div
      className={cn(
        "flex max-h-[600px] flex-col rounded-xl border bg-card text-card-foreground",
        className,
      )}
    >
      {sortedIterations.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
              <span className="font-semibold text-foreground">
                Today
              </span>
              {todayStats.total > 0 ? (
                <>
                  <span className="text-muted-foreground">
                    {todayStats.total} run{todayStats.total === 1 ? "" : "s"}
                  </span>
                  {todayStats.passRate !== null ? (
                    <span
                      className={cn(
                        "tabular-nums",
                        todayStats.passRate >= 80
                          ? "text-success"
                          : todayStats.passRate >= 50
                            ? "text-warning"
                            : "text-destructive",
                      )}
                    >
                      {todayStats.passRate}% pass
                    </span>
                  ) : null}
                  {todayStats.failed > 0 ? (
                    <span className="text-destructive">
                      {todayStats.failed} failed
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-muted-foreground">No runs today</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter by case title…"
                  className="h-7 w-44 rounded-md border border-input bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Filter executions by case title"
                />
              </div>
              <div
                role="tablist"
                aria-label="Filter executions by result"
                className="flex shrink-0 items-center gap-0.5 rounded-md border border-input bg-background p-0.5"
              >
                {(
                  [
                    { value: "all", label: "All" },
                    { value: "passed", label: "Passed" },
                    { value: "failed", label: "Failed" },
                    { value: "other", label: "Other" },
                  ] as Array<{ value: ExecutionFilter; label: string }>
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === option.value}
                    onClick={() => setFilter(option.value)}
                    className={cn(
                      "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                      filter === option.value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex w-full items-center gap-3 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
            <div className="min-w-[120px] flex-1">Test case</div>
            <div className="w-24 shrink-0 text-right">Result</div>
            <div className="w-44 shrink-0 text-right">Timestamp</div>
            <span className="w-4 shrink-0" aria-hidden />
          </div>
        </>
      ) : null}

      <div className={cn("divide-y overflow-y-auto", listClassName)}>
        {sortedIterations.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No executions found.
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No executions match the current filter.
          </div>
        ) : (
          visible.map(({ iteration, title: caseTitle }) => {
            const timestamp = getIterationRecencyTimestamp(iteration);
            const timestampLabel = formatTime(timestamp || undefined);
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
