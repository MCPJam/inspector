import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { IterationDetails } from "./iteration-details";
import { formatTime } from "./helpers";
import { EvalCase, EvalIteration, EvalSuite, SuiteAggregate } from "./types";

export function SuiteIterationsView({
  suite,
  cases,
  iterations,
  aggregate,
  onBack,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  aggregate: SuiteAggregate | null;
  onBack: () => void;
}) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);
  const [expandedQueries, setExpandedQueries] = useState<Set<string>>(
    new Set(),
  );
  const caseGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        testCase: EvalCase | null;
        iterations: EvalIteration[];
        summary: {
          runs: number;
          passed: number;
          failed: number;
          cancelled: number;
          pending: number;
          tokens: number;
          avgDuration: number | null;
        };
      }
    >();

    const computeSummary = (items: EvalIteration[]) => {
      const summary = {
        runs: items.length,
        passed: 0,
        failed: 0,
        cancelled: 0,
        pending: 0,
        tokens: 0,
        avgDuration: null as number | null,
      };

      let totalDuration = 0;
      let durationCount = 0;

      items.forEach((iteration) => {
        if (iteration.result === "passed") summary.passed += 1;
        else if (iteration.result === "failed") summary.failed += 1;
        else if (iteration.result === "cancelled") summary.cancelled += 1;
        else summary.pending += 1;

        summary.tokens += iteration.tokensUsed || 0;

        const startedAt = iteration.startedAt ?? iteration.createdAt;
        const completedAt = iteration.updatedAt ?? iteration.createdAt;
        if (startedAt && completedAt) {
          const duration = Math.max(completedAt - startedAt, 0);
          totalDuration += duration;
          durationCount += 1;
        }
      });

      if (durationCount > 0) {
        summary.avgDuration = totalDuration / durationCount;
      }

      return summary;
    };

    cases.forEach((testCase) => {
      groups.set(testCase._id, {
        testCase,
        iterations: [],
        summary: {
          runs: 0,
          passed: 0,
          failed: 0,
          cancelled: 0,
          pending: 0,
          tokens: 0,
          avgDuration: null,
        },
      });
    });

    const unassigned: {
      testCase: EvalCase | null;
      iterations: EvalIteration[];
      summary: {
        runs: number;
        passed: number;
        failed: number;
        cancelled: number;
        pending: number;
        tokens: number;
        avgDuration: number | null;
      };
    } = {
      testCase: null,
      iterations: [],
      summary: {
        runs: 0,
        passed: 0,
        failed: 0,
        cancelled: 0,
        pending: 0,
        tokens: 0,
        avgDuration: null,
      },
    };

    iterations.forEach((iteration) => {
      const targetGroup = iteration.testCaseId
        ? groups.get(iteration.testCaseId)
        : undefined;

      if (targetGroup) {
        targetGroup.iterations.push(iteration);
      } else {
        unassigned.iterations.push(iteration);
      }
    });

    const orderedGroups = cases.map((testCase) => {
      const group = groups.get(testCase._id)!;
      const sortedIterations = [...group.iterations].sort((a, b) => {
        if (a.iterationNumber != null && b.iterationNumber != null) {
          return a.iterationNumber - b.iterationNumber;
        }
        return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      });
      return {
        ...group,
        iterations: sortedIterations,
        summary: computeSummary(sortedIterations),
      };
    });

    if (unassigned.iterations.length > 0) {
      const sortedUnassigned = [...unassigned.iterations].sort((a, b) => {
        if (a.iterationNumber != null && b.iterationNumber != null) {
          return a.iterationNumber - b.iterationNumber;
        }
        return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      });
      orderedGroups.push({
        ...unassigned,
        iterations: sortedUnassigned,
        summary: computeSummary(sortedUnassigned),
      });
    }

    return orderedGroups;
  }, [cases, iterations]);

  const getIterationBorderColor = (result: string) => {
    if (result === "passed") return "bg-emerald-500/50";
    if (result === "failed") return "bg-red-500/50";
    if (result === "cancelled") return "bg-zinc-300/50";
    return "bg-amber-500/50"; // pending
  };

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back to suites
        </Button>
      </div>
      <div className="space-y-4">
        {caseGroups.map((group, index) => {
          const { testCase, iterations: groupIterations } = group;
          const hasIterations = groupIterations.length > 0;
          const caseId = testCase?._id ?? `unassigned-${index}`;
          const isQueryExpanded = expandedQueries.has(caseId);
          const queryMaxLength = 100;
          const shouldTruncate =
            testCase?.query && testCase.query.length > queryMaxLength;
          const displayQuery =
            shouldTruncate && !isQueryExpanded
              ? testCase.query.slice(0, queryMaxLength) + "..."
              : testCase?.query;

          const toggleQuery = () => {
            setExpandedQueries((prev) => {
              const newSet = new Set(prev);
              if (newSet.has(caseId)) {
                newSet.delete(caseId);
              } else {
                newSet.add(caseId);
              }
              return newSet;
            });
          };

          return (
            <div key={caseId} className="overflow-hidden rounded-xl border">
              <div className="border-b bg-muted/50 px-4 py-2.5">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold pr-2">
                      {testCase ? testCase.title : "Unassigned iterations"}
                    </h3>
                    {testCase?.provider ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          {testCase.provider}
                        </span>
                      </>
                    ) : null}
                    {testCase?.model ? (
                      <>
                        <span className="text-muted-foreground">•</span>
                        <span className="text-xs text-muted-foreground">
                          {testCase.model}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {testCase?.query ? (
                    <div className="flex items-start gap-2">
                      <p className="text-xs text-muted-foreground italic flex-1">
                        "{displayQuery}"
                      </p>
                      {shouldTruncate ? (
                        <button
                          onClick={toggleQuery}
                          className="text-xs text-primary hover:underline focus:outline-none whitespace-nowrap"
                        >
                          {isQueryExpanded ? "Show less" : "Show more"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {hasIterations ? (
                <div className="divide-y">
                  {groupIterations.map((iteration) => {
                    const isOpen = openIterationId === iteration._id;
                    const startedAt =
                      iteration.startedAt ?? iteration.createdAt;
                    const completedAt =
                      iteration.updatedAt ?? iteration.createdAt;
                    const durationMs =
                      startedAt && completedAt
                        ? Math.max(completedAt - startedAt, 0)
                        : null;
                    const isPending = iteration.result === "pending";

                    return (
                      <div
                        key={iteration._id}
                        className={`relative ${isPending ? "opacity-60" : ""}`}
                      >
                        <div
                          className={`absolute left-0 top-0 h-full w-1 ${getIterationBorderColor(iteration.result)}`}
                        />
                        <button
                          onClick={() => {
                            if (!isPending) {
                              setOpenIterationId((current) =>
                                current === iteration._id
                                  ? null
                                  : iteration._id,
                              );
                            }
                          }}
                          disabled={isPending}
                          className={`flex w-full items-center gap-4 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                            isPending
                              ? "cursor-not-allowed"
                              : "cursor-pointer hover:bg-muted/50"
                          }`}
                        >
                          <div className="grid min-w-0 flex-1 grid-cols-[auto_1fr_auto_auto] items-center gap-4 pl-3">
                            <div className="text-muted-foreground">
                              {isPending ? (
                                <ChevronRight className="h-4 w-4" />
                              ) : isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">
                                Iteration #{iteration.iterationNumber}
                              </span>
                              {isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                              ) : null}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {isPending
                                ? "—"
                                : `${Number(iteration.tokensUsed || 0).toLocaleString()} tokens`}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {isPending
                                ? "—"
                                : durationMs !== null
                                  ? formatDuration(durationMs)
                                  : "—"}
                            </div>
                          </div>
                        </button>
                        {isOpen && !isPending ? (
                          <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                            <IterationDetails
                              iteration={iteration}
                              testCase={testCase}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No iterations recorded for this test case yet.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
