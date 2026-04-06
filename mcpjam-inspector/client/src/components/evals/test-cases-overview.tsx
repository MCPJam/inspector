import { useEffect, useMemo, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { computeIterationResult } from "./pass-criteria";
import { formatRelativeTime } from "./helpers";
import { cn } from "@/lib/utils";
import type { EvalCase, EvalIteration } from "./types";

interface TestCasesOverviewProps {
  suite: { _id: string; name: string; source?: "ui" | "sdk" };
  cases: EvalCase[];
  allIterations: EvalIteration[];
  runsViewMode: "runs" | "test-cases";
  onViewModeChange: (value: "runs" | "test-cases") => void;
  onTestCaseClick: (testCaseId: string) => void;
  clickHint?: string;
  onCreateTestCase?: () => void;
  onGenerateTestCases?: () => void;
  canGenerateTestCases?: boolean;
  runTrendData: Array<{
    runId: string;
    runIdDisplay: string;
    passRate: number;
    label: string;
  }>;
  modelStats: Array<{
    model: string;
    passRate: number;
    passed: number;
    failed: number;
    total: number;
  }>;
  runsLoading: boolean;
  onRunClick?: (runId: string) => void;
}

export function TestCasesOverview({
  suite,
  cases,
  allIterations,
  runsViewMode,
  onViewModeChange,
  onTestCaseClick,
  clickHint = "Click on a case to view its run history and performance.",
  onCreateTestCase,
  onGenerateTestCases,
  canGenerateTestCases = false,
}: TestCasesOverviewProps) {
  const convex = useConvex();
  const liveCases = useQuery(
    "testSuites:listTestCases" as any,
    { suiteId: suite._id } as any,
  ) as EvalCase[] | undefined;
  const [hydratedIterations, setHydratedIterations] = useState<EvalIteration[]>(
    [],
  );

  const effectiveCases = useMemo(() => {
    if (!liveCases) {
      return cases;
    }

    const liveCaseById = new Map(
      liveCases.map((testCase) => [testCase._id, testCase] as const),
    );
    const mergedCases = cases.map((testCase) => ({
      ...testCase,
      ...(liveCaseById.get(testCase._id) ?? {}),
    }));

    for (const liveCase of liveCases) {
      if (!cases.some((testCase) => testCase._id === liveCase._id)) {
        mergedCases.push(liveCase);
      }
    }

    return mergedCases;
  }, [cases, liveCases]);

  useEffect(() => {
    const localIterationIds = new Set(
      allIterations.map((iteration) => iteration._id),
    );
    const localCaseIds = new Set(
      allIterations
        .map((iteration) => iteration.testCaseId)
        .filter(
          (testCaseId): testCaseId is string => typeof testCaseId === "string",
        ),
    );
    const casesNeedingHydration = effectiveCases.filter((testCase) => {
      const missingSavedIteration =
        typeof testCase.lastMessageRun === "string" &&
        !localIterationIds.has(testCase.lastMessageRun);
      const hasLocalIterations = localCaseIds.has(testCase._id);
      return missingSavedIteration || !hasLocalIterations;
    });

    if (casesNeedingHydration.length === 0) {
      setHydratedIterations((current) => (current.length === 0 ? current : []));
      return;
    }

    let cancelled = false;

    void (async () => {
      const fetched = await Promise.all(
        casesNeedingHydration.map(async (testCase) => {
          try {
            const iterations = (await convex.query(
              "testSuites:listTestIterations" as any,
              { testCaseId: testCase._id } as any,
            )) as EvalIteration[] | undefined;

            if (Array.isArray(iterations) && iterations.length > 0) {
              return iterations;
            }
          } catch (error) {
            console.error(
              "Failed to hydrate test case iterations from listTestIterations:",
              error,
            );
          }

          if (!testCase.lastMessageRun) {
            return [];
          }

          try {
            const iteration = (await convex.query(
              "testSuites:getTestIteration" as any,
              { iterationId: testCase.lastMessageRun } as any,
            )) as EvalIteration | null;
            return iteration ? [iteration] : [];
          } catch (error) {
            console.error(
              "Failed to hydrate saved iteration from getTestIteration:",
              error,
            );
            return [];
          }
        }),
      );

      if (cancelled) {
        return;
      }

      const deduped = new Map<string, EvalIteration>();
      for (const iteration of [...allIterations, ...fetched.flat()]) {
        if (iteration?._id) {
          deduped.set(iteration._id, iteration);
        }
      }
      setHydratedIterations(Array.from(deduped.values()));
    })();

    return () => {
      cancelled = true;
    };
  }, [allIterations, convex, effectiveCases]);

  const effectiveIterations = useMemo(() => {
    const deduped = new Map<string, EvalIteration>();
    for (const iteration of [...allIterations, ...hydratedIterations]) {
      if (iteration?._id) {
        deduped.set(iteration._id, iteration);
      }
    }
    return Array.from(deduped.values());
  }, [allIterations, hydratedIterations]);

  const savedIterationById = useMemo(
    () =>
      new Map(
        effectiveIterations.map(
          (iteration) => [iteration._id, iteration] as const,
        ),
      ),
    [effectiveIterations],
  );

  // Calculate stats for each test case
  const testCaseStats = useMemo(() => {
    return effectiveCases.map((testCase) => {
      const caseIterations = effectiveIterations.filter(
        (iter) => iter.testCaseId === testCase._id,
      );

      // Only count completed iterations - exclude pending/cancelled
      const iterationResults = caseIterations.map((iter) =>
        computeIterationResult(iter),
      );
      const passed = iterationResults.filter((r) => r === "passed").length;
      const total = iterationResults.filter(
        (r) => r === "passed" || r === "failed",
      ).length;
      const avgAccuracy = total > 0 ? Math.round((passed / total) * 100) : 0;

      return {
        testCase,
        iterations: total,
        avgAccuracy,
        savedIteration:
          testCase.lastMessageRun != null
            ? (savedIterationById.get(testCase.lastMessageRun) ?? null)
            : null,
      };
    });
  }, [effectiveCases, effectiveIterations, savedIterationById]);

  return (
    <>
      {/* Cases List */}
      <div className="rounded-xl border bg-card text-card-foreground flex flex-col max-h-[600px]">
        <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{clickHint}</p>
          </div>
          <div className="flex items-center gap-2">
            {onGenerateTestCases ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={onGenerateTestCases}
                disabled={!canGenerateTestCases}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Generate
              </Button>
            ) : null}
            {onCreateTestCase ? (
              <Button
                type="button"
                size="sm"
                className="h-8"
                onClick={onCreateTestCase}
              >
                <Plus className="h-3.5 w-3.5" />
                New case
              </Button>
            ) : null}
            <select
              value={runsViewMode}
              onChange={(e) =>
                onViewModeChange(e.target.value as "runs" | "test-cases")
              }
              className="text-xs border rounded px-2 py-1 bg-background"
            >
              <option value="runs">Runs</option>
              <option value="test-cases">Cases</option>
            </select>
          </div>
        </div>

        {/* Column Headers */}
        {testCaseStats.length > 0 && (
          <div className="flex items-center gap-6 w-full px-4 py-1.5 bg-muted/30 border-b text-xs font-medium text-muted-foreground">
            <div className="flex-1 min-w-[200px]">Case Name</div>
            <div className="min-w-[100px] text-right">Iterations</div>
            <div className="min-w-[100px] text-right">
              {suite.source === "sdk" ? "Avg Pass Rate" : "Avg Accuracy"}
            </div>
            <div className="hidden min-w-[168px] text-left md:block">
              Last saved
            </div>
          </div>
        )}

        <div className="divide-y overflow-y-auto">
          {testCaseStats.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No cases found.
            </div>
          ) : (
            testCaseStats.map(
              ({ testCase, iterations, avgAccuracy, savedIteration }) => {
                const savedResult = savedIteration
                  ? computeIterationResult(savedIteration)
                  : null;
                const savedToneClass =
                  savedResult === "passed"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : savedResult === "failed"
                      ? "text-rose-600 dark:text-rose-400"
                      : savedResult === "cancelled"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground";
                const savedLabel =
                  savedResult === "passed"
                    ? "Passed"
                    : savedResult === "failed"
                      ? "Failed"
                      : savedResult === "cancelled"
                        ? "Cancelled"
                        : savedResult === "pending"
                          ? "Running"
                          : "Not saved";
                const savedModelLabel =
                  savedIteration?.testCaseSnapshot?.model ??
                  testCase.models[0]?.model ??
                  null;
                const savedTimestamp =
                  savedIteration?.updatedAt ??
                  savedIteration?.startedAt ??
                  savedIteration?.createdAt ??
                  null;

                return (
                  <button
                    key={testCase._id}
                    onClick={() => onTestCaseClick(testCase._id)}
                    className="flex items-center gap-6 w-full px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    <div className="min-w-[200px] flex-1">
                      <div className="truncate text-xs font-medium">
                        {testCase.title || "Untitled test case"}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground md:hidden">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            savedToneClass,
                          )}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          {savedLabel}
                        </span>
                        {savedTimestamp ? (
                          <span>{formatRelativeTime(savedTimestamp)}</span>
                        ) : null}
                      </div>
                    </div>
                    <span className="min-w-[100px] text-right text-xs font-mono text-muted-foreground">
                      {iterations}
                    </span>
                    <span className="min-w-[100px] text-right text-xs font-mono text-muted-foreground">
                      {iterations > 0 ? `${avgAccuracy}%` : "—"}
                    </span>
                    <div className="hidden min-w-[168px] md:block">
                      {savedIteration ? (
                        <div className="min-w-0">
                          <div
                            className={cn(
                              "inline-flex items-center gap-1.5 text-xs font-medium",
                              savedToneClass,
                            )}
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                            {savedLabel}
                            <span className="font-normal text-muted-foreground">
                              ·{" "}
                              {formatRelativeTime(savedTimestamp ?? undefined)}
                            </span>
                          </div>
                          {savedModelLabel ? (
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {savedModelLabel}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not saved
                        </span>
                      )}
                    </div>
                  </button>
                );
              },
            )
          )}
        </div>
      </div>
    </>
  );
}
