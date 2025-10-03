import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
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
  const [statusFilter, setStatusFilter] = useState<
    "all" | "passed" | "failed" | "cancelled" | "pending"
  >("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [modelFilter, setModelFilter] = useState<string>("all");

  const caseById = useMemo(() => {
    return new Map(cases.map((testCase) => [testCase._id, testCase]));
  }, [cases]);

  const providerOptions = useMemo(() => {
    const providers = new Set<string>();
    cases.forEach((testCase) => {
      if (testCase.provider) providers.add(testCase.provider);
    });
    return Array.from(providers).sort();
  }, [cases]);

  const modelOptions = useMemo(() => {
    const models = new Set<string>();
    cases.forEach((testCase) => {
      if (testCase.model) models.add(testCase.model);
    });
    return Array.from(models).sort();
  }, [cases]);

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
          lastRunAt: number | null;
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
        lastRunAt: null as number | null,
      };

      items.forEach((iteration) => {
        if (iteration.result === "passed") summary.passed += 1;
        else if (iteration.result === "failed") summary.failed += 1;
        else if (iteration.result === "cancelled") summary.cancelled += 1;
        else summary.pending += 1;

        summary.tokens += Number(iteration.tokensUsed || 0);

        const timestamp = iteration.updatedAt ?? iteration.startedAt ?? iteration.createdAt;
        if (timestamp != null) {
          summary.lastRunAt = summary.lastRunAt
            ? Math.max(summary.lastRunAt, timestamp)
            : timestamp;
        }
      });

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
          lastRunAt: null,
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
        lastRunAt: number | null;
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
        lastRunAt: null,
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
      const sortedIterations = [...group.iterations].sort(
        (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
      );
      return {
        ...group,
        iterations: sortedIterations,
        summary: computeSummary(sortedIterations),
      };
    });

    if (unassigned.iterations.length > 0) {
      const sortedUnassigned = [...unassigned.iterations].sort(
        (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
      );
      orderedGroups.push({
        ...unassigned,
        iterations: sortedUnassigned,
        summary: computeSummary(sortedUnassigned),
      });
    }

    return orderedGroups;
  }, [cases, iterations]);

  const matchesStatusFilter = useCallback(
    (iteration: EvalIteration) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "pending") {
        return (
          iteration.result === "pending" ||
          iteration.status === "pending" ||
          iteration.status === "running"
        );
      }
      return iteration.result === statusFilter;
    },
    [statusFilter],
  );

  const filteredGroups = useMemo(() => {
    return caseGroups
      .filter((group) => {
        if (!group.testCase) {
          return providerFilter === "all" && modelFilter === "all";
        }
        const providerMatches =
          providerFilter === "all" || group.testCase.provider === providerFilter;
        const modelMatches =
          modelFilter === "all" || group.testCase.model === modelFilter;
        return providerMatches && modelMatches;
      })
      .map((group) => ({
        ...group,
        filteredIterations: group.iterations.filter(matchesStatusFilter),
      }));
  }, [caseGroups, matchesStatusFilter, modelFilter, providerFilter]);

  const filteredCount = useMemo(() => {
    return filteredGroups.reduce(
      (total, group) => total + group.filteredIterations.length,
      0,
    );
  }, [filteredGroups]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Back to suites
          </Button>
          <div>
            <h2 className="text-xl font-semibold">
              Suite started {formatTime(suite._creationTime)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {aggregate?.totals.passed ?? 0} passed ·{" "}
              {aggregate?.totals.failed ?? 0} failed ·{" "}
              {aggregate?.totals.cancelled ?? 0} cancelled ·
              {(aggregate?.totals.tokens ?? 0).toLocaleString()} tokens
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Showing {filteredCount} of {iterations.length} iterations
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            setStatusFilter(
              value as "all" | "passed" | "failed" | "cancelled" | "pending",
            )
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="passed">Passed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={providerFilter}
          onValueChange={(value) => setProviderFilter(value)}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {providerOptions.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={modelFilter} onValueChange={(value) => setModelFilter(value)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Model" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All models</SelectItem>
            {modelOptions.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border">
        <div className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          Iterations ({filteredCount})
        </div>
        <div className="divide-y">
          {filteredGroups.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">
              No iterations match the current filters.
            </div>
          ) : (
            filteredGroups.map((group, index) => {
              const { testCase, summary, filteredIterations } = group;
              const showNoIterationsMessage =
                (testCase && summary.runs === 0) || filteredIterations.length === 0;

              return (
                <div key={testCase?._id ?? `unassigned-${index}`} className="space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-3 bg-muted/30 px-4 py-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold">
                          {testCase ? testCase.title : "Unassigned iterations"}
                        </h3>
                        {testCase ? (
                          <>
                            <Badge variant="outline" className="capitalize">
                              {testCase.provider}
                            </Badge>
                            <Badge variant="outline" className="font-mono text-xs">
                              {testCase.model}
                            </Badge>
                          </>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        <span>
                          {summary.runs} iteration{summary.runs === 1 ? "" : "s"}
                        </span>
                        <span>Tokens {summary.tokens.toLocaleString()}</span>
                        <span>
                          Last run {summary.lastRunAt ? formatTime(summary.lastRunAt) : "—"}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="outline" className="border-green-200 text-green-700">
                        Passed {summary.passed}
                      </Badge>
                      <Badge variant="outline" className="border-red-200 text-red-700">
                        Failed {summary.failed}
                      </Badge>
                      <Badge variant="outline" className="border-yellow-200 text-yellow-700">
                        Pending {summary.pending}
                      </Badge>
                      <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground">
                        Cancelled {summary.cancelled}
                      </Badge>
                    </div>
                  </div>

                  {showNoIterationsMessage ? (
                    <div className="px-4 pb-4 text-sm text-muted-foreground">
                      {summary.runs === 0
                        ? "No iterations recorded for this test case yet."
                        : "No iterations match the current filters."}
                    </div>
                  ) : (
                    <div className="space-y-1 px-2 pb-3">
                      {filteredIterations.map((iteration) => {
                        const isOpen = openIterationId === iteration._id;
                        const startedAt = iteration.startedAt ?? iteration.createdAt;
                        const completedAt = iteration.updatedAt ?? iteration.createdAt;
                        const durationMs =
                          startedAt && completedAt ? Math.max(completedAt - startedAt, 0) : null;
                        const expectedTools = testCase?.expectedToolCalls.length ?? 0;
                        const actualTools = iteration.actualToolCalls.length;
                        const toolSummary = expectedTools
                          ? `${actualTools}/${expectedTools} tools`
                          : `${actualTools} tools`;

                        return (
                          <div
                            key={iteration._id}
                            className="rounded-lg border border-border bg-background"
                          >
                            <button
                              onClick={() =>
                                setOpenIterationId((current) =>
                                  current === iteration._id ? null : iteration._id,
                                )
                              }
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                            >
                              <div className="text-muted-foreground">
                                {isOpen ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </div>
                              <Badge
                                variant="outline"
                                className="capitalize border-transparent bg-secondary/40"
                              >
                                {iteration.result}
                              </Badge>
                              <span className="text-xs font-semibold">
                                #{iteration.iterationNumber}
                              </span>
                              <div className="flex flex-1 flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                <span>
                                  Started {startedAt ? formatTime(startedAt) : "Not started"}
                                </span>
                                <span>
                                  Updated {completedAt ? formatTime(completedAt) : "—"}
                                </span>
                                {durationMs !== null ? (
                                  <span>Duration {formatDuration(durationMs)}</span>
                                ) : null}
                                <span>Tokens {Number(iteration.tokensUsed || 0).toLocaleString()}</span>
                                <span>{toolSummary}</span>
                              </div>
                            </button>
                            {isOpen ? (
                              <div className="px-4 pb-4">
                                <IterationDetails
                                  iteration={iteration}
                                  testCase={
                                    iteration.testCaseId
                                      ? caseById.get(iteration.testCaseId) ?? null
                                      : null
                                  }
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
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
  return remainingMinutes
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}
