import { useMemo } from "react";
import { Trash2, Loader2, X, Server } from "lucide-react";
import type { EvalSuite, EvalSuiteOverviewEntry } from "./types";
import { cn } from "@/lib/utils";

interface SuitesOverviewProps {
  overview: EvalSuiteOverviewEntry[];
  onSelectSuite: (id: string) => void;
  onRerun: (suite: EvalSuite) => void;
  onCancelRun: (runId: string) => void;
  onDelete: (suite: EvalSuite) => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
  cancellingRunId: string | null;
  deletingSuiteId: string | null;
}

export function SuitesOverview({
  overview,
  onSelectSuite,
  onRerun,
  onCancelRun,
  onDelete,
  connectedServerNames: _connectedServerNames,
  rerunningSuiteId,
  cancellingRunId,
  deletingSuiteId,
}: SuitesOverviewProps) {
  if (overview.length === 0) {
    return (
      <div className="h-[calc(100vh-220px)] flex items-center justify-center rounded-xl border border-dashed">
        <div className="text-center space-y-2">
          <div className="text-lg font-semibold">No evaluation suites yet</div>
          <p className="text-sm text-muted-foreground">
            Trigger a test run to see your evaluation history here.
          </p>
        </div>
      </div>
    );
  }

  const sortedOverview = useMemo(
    () =>
      [...overview].sort((a, b) => {
        const aTime =
          a.suite.updatedAt ??
          a.latestRun?.completedAt ??
          a.latestRun?.createdAt ??
          a.suite._creationTime ??
          0;
        const bTime =
          b.suite.updatedAt ??
          b.latestRun?.completedAt ??
          b.latestRun?.createdAt ??
          b.suite._creationTime ??
          0;
        return bTime - aTime;
      }),
    [overview],
  );

  const aggregateCounts = useMemo(() => {
    let passing = 0, partial = 0, failing = 0;
    for (const { latestRun } of sortedOverview) {
      if (!latestRun?.summary) { failing++; continue; }
      const rate = latestRun.summary.passRate;
      if (rate >= 1) passing++;
      else if (rate > 0) partial++;
      else failing++;
    }
    return { total: sortedOverview.length, passing, partial, failing };
  }, [sortedOverview]);

  return (
    <div className="space-y-4">
      {/* Stats banner */}
      <div className="flex items-stretch divide-x divide-border/50 rounded-xl border border-border/50 bg-card shadow-sm">
        {[
          { label: "Suites", value: aggregateCounts.total, cls: "" },
          { label: "Passing", value: aggregateCounts.passing, cls: "text-success" },
          { label: "Partial", value: aggregateCounts.partial, cls: "text-warning" },
          { label: "Failing", value: aggregateCounts.failing, cls: "text-destructive" },
        ].map(({ label, value, cls }) => (
          <div key={label} className="flex flex-1 flex-col px-5 py-3.5">
            <span className={cn("text-2xl font-semibold tabular-nums leading-none", cls)}>
              {value}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {sortedOverview.map((entry) => {
          const { suite, latestRun, totals } = entry;

          const servers = suite.environment?.servers ?? [];
          const hasServersConfigured = servers.length > 0;
          const canRerun = hasServersConfigured;
          const isRerunning = rerunningSuiteId === suite._id;

          const latestPassRate = latestRun?.summary
            ? Math.round(latestRun.summary.passRate * 100)
            : 0;

          const lastRunPassed = latestRun?.summary?.passed ?? 0;
          const lastRunFailed = latestRun?.summary?.failed ?? 0;
          const lastRunTotal = latestRun?.summary?.total ?? 0;

          const runsLabel =
            totals.runs === 1 ? "1 run" : `${totals.runs} runs total`;

          const isRunInProgress =
            latestRun?.status === "running" || latestRun?.status === "pending";

          const isCancelling = cancellingRunId === latestRun?._id;

          // Show running state if either local state OR actual run status indicates running
          const showAsRunning = isRerunning || isRunInProgress;

          const lastRunTimestamp =
            latestRun?.completedAt ??
            latestRun?.createdAt ??
            suite.updatedAt ??
            suite._creationTime ??
            null;

          const lastRunLabel = lastRunTimestamp
            ? new Date(lastRunTimestamp).toLocaleString()
            : "No runs yet";

          return (
            <div
              key={suite._id}
              className="rounded-xl border bg-card text-card-foreground shadow-sm hover:border-primary/40 transition-colors"
            >
              <button
                onClick={() => onSelectSuite(suite._id)}
                className="w-full text-left"
              >
                <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1 space-y-2">
                    <div className="flex flex-col gap-1">
                      <h2 className="text-base font-semibold">
                        {suite.name || "Untitled suite"}
                      </h2>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {showAsRunning ? (
                        <>
                          <span className="flex items-center gap-1.5 text-primary font-medium">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Run in progress
                          </span>
                          <span>•</span>
                        </>
                      ) : null}
                      <span>{lastRunLabel}</span>
                      <span>•</span>
                      <span>{runsLabel}</span>
                      {servers.length > 0 ? (
                        <>
                          <span>•</span>
                          <span className="flex flex-wrap gap-1">
                            {servers.map((s) => (
                              <span
                                key={s}
                                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                              >
                                <Server className="h-2.5 w-2.5" />
                                {s}
                              </span>
                            ))}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-6 sm:flex-col sm:items-end sm:gap-3">
                    <div className="text-right">
                      <div className="text-2xl font-semibold">
                        {latestPassRate}%
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last run {lastRunLabel}
                      </div>
                    </div>
                    {latestRun && latestRun.summary ? (
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">
                          {lastRunPassed} passed · {lastRunFailed} failed
                          {lastRunTotal > 0 && (
                            <span> · {lastRunTotal} total</span>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </button>
              <div className="flex items-center justify-between border-t px-4 py-2.5">
                <div className="flex items-center gap-3">
                  {isRunInProgress && latestRun ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelRun(latestRun._id);
                      }}
                      disabled={isCancelling}
                      className="flex items-center gap-1.5 text-xs font-medium text-destructive hover:underline disabled:opacity-60"
                    >
                      {isCancelling ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Cancelling...
                        </>
                      ) : (
                        <>
                          <X className="h-3 w-3" />
                          Cancel run
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => onRerun(suite)}
                      disabled={!canRerun || showAsRunning}
                      className={cn(
                        "text-xs font-medium text-primary hover:underline disabled:opacity-60",
                        !canRerun && "cursor-not-allowed",
                      )}
                    >
                      {showAsRunning
                        ? "Running..."
                        : hasServersConfigured
                          ? "Rerun suite"
                          : "No servers configured"}
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(suite);
                    }}
                    disabled={deletingSuiteId === suite._id}
                    className="text-xs font-medium text-destructive hover:underline disabled:opacity-60"
                    title="Delete suite"
                  >
                    {deletingSuiteId === suite._id ? (
                      "Deleting..."
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
