import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@/lib/utils";
import { computeIterationResult } from "./pass-criteria";
import { evalStatusLeftBorderClasses } from "./helpers";
import { IterationDetails } from "./iteration-details";
import type { EvalCase, EvalIteration } from "./types";

interface TestCaseIterationsTableProps {
  testCase: EvalCase;
  iterations: EvalIteration[];
  onViewRun?: (runId: string) => void;
  serverNames?: string[];
  /** Override the "Iterations" header. Pass empty string to omit. */
  label?: string;
  emptyState?: string;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
}

export function TestCaseIterationsTable({
  testCase,
  iterations,
  onViewRun,
  serverNames = [],
  label = "Iterations",
  emptyState = "No iterations found for this test.",
}: TestCaseIterationsTableProps) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);

  const sortedIterations = (() => {
    const failing = iterations.filter(
      (i) => computeIterationResult(i) === "failed",
    );
    const passing = iterations.filter(
      (i) => computeIterationResult(i) === "passed",
    );
    const other = iterations.filter((i) => {
      const r = computeIterationResult(i);
      return r !== "failed" && r !== "passed";
    });
    return [...failing, ...passing, ...other];
  })();

  return (
    <div className="space-y-2">
      {label ? (
        <Label className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
      ) : null}
      {iterations.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {emptyState}
        </div>
      ) : (
        <div className="rounded-md border bg-card text-card-foreground divide-y overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-3 py-1.5 bg-muted/30 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            <div className="flex min-w-0 flex-1 items-center gap-3 pl-2">
              <div className="w-3.5" />
              <span>Result</span>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <div className="min-w-[120px] text-left">Model</div>
              <div className="min-w-[50px] text-center">Calls</div>
              <div className="min-w-[60px] text-center">Tokens</div>
              <div className="min-w-[40px] text-right">Time</div>
              {onViewRun && <div className="min-w-[100px]">Run</div>}
            </div>
          </div>
          {sortedIterations.map((iteration) => {
            const snapshot = iteration.testCaseSnapshot;
            const startedAt = iteration.startedAt ?? iteration.createdAt;
            const completedAt = iteration.updatedAt ?? iteration.createdAt;
            const durationMs =
              startedAt && completedAt
                ? Math.max(completedAt - startedAt, 0)
                : null;
            const actualToolCalls = iteration.actualToolCalls || [];
            const computedResult = computeIterationResult(iteration);
            const isPending = iteration.result === "pending";
            const isLive =
              iteration.status === "pending" ||
              iteration.status === "running" ||
              computedResult === "pending";
            const isOpen = openIterationId === iteration._id;

            return (
              <div
                key={iteration._id}
                className={cn(
                  "relative border-l-2",
                  evalStatusLeftBorderClasses(
                    isLive ? "running" : computedResult,
                  ),
                  isPending && "opacity-60",
                )}
              >
                <button
                  title={`Iteration ${computedResult}`}
                  onClick={() =>
                    setOpenIterationId(isOpen ? null : iteration._id)
                  }
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer hover:bg-muted/50"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3 pl-2">
                    <div className="text-muted-foreground shrink-0">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="text-xs font-medium truncate">
                        {snapshot?.title ?? "Iteration"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                    <div className="min-w-[120px] text-left truncate">
                      <span className="font-mono text-xs">
                        {snapshot
                          ? `${snapshot.provider}/${snapshot.model}`
                          : "—"}
                      </span>
                    </div>
                    <div className="min-w-[50px] text-center">
                      <span className="font-mono">
                        {isPending ? "—" : actualToolCalls.length}
                      </span>
                    </div>
                    <div className="min-w-[60px] text-center">
                      <span className="font-mono">
                        {isPending
                          ? "—"
                          : Number(
                              iteration.tokensUsed || 0,
                            ).toLocaleString()}
                      </span>
                    </div>
                    <div className="font-mono min-w-[40px] text-right">
                      {isPending
                        ? "—"
                        : durationMs !== null
                          ? formatDuration(durationMs)
                          : "—"}
                    </div>
                    {iteration.suiteRunId && onViewRun && !isPending && (
                      <div className="min-w-[100px]">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 text-[11px] px-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            onViewRun(iteration.suiteRunId!);
                          }}
                        >
                          {formatTimeAgo(iteration.createdAt)}
                        </Button>
                      </div>
                    )}
                    {isPending && (
                      <div className="w-3.5 flex items-center justify-center">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
                      </div>
                    )}
                  </div>
                </button>
                {isOpen && (
                  <div className="border-t bg-muted/20 px-4 pb-4 pt-3 pl-8">
                    <IterationDetails
                      iteration={iteration}
                      testCase={testCase}
                      serverNames={serverNames}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
