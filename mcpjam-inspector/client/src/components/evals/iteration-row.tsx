import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { EvalIteration, EvalCase } from "./types";
import { IterationDetails } from "./iteration-details";
import { formatRunId } from "./helpers";

interface IterationRowProps {
  iteration: EvalIteration;
  testCase: EvalCase | null;
  iterationTestCase?: EvalCase | null;
  iterationRun?: { _id: string } | null;
  onViewRun?: (runId: string) => void;
  getIterationBorderColor: (result: string) => string;
  formatTime: (ts?: number) => string;
  formatDuration: (ms: number) => string;
  isOpen?: boolean;
  onToggle?: () => void;
}

export function CompactIterationRow({
  iteration,
  testCase,
  iterationTestCase,
  iterationRun,
  onViewRun,
  getIterationBorderColor,
  formatTime,
  formatDuration,
  isOpen = false,
  onToggle,
}: IterationRowProps) {
  const startedAt = iteration.startedAt ?? iteration.createdAt;
  const completedAt = iteration.updatedAt ?? iteration.createdAt;
  const durationMs =
    startedAt && completedAt ? Math.max(completedAt - startedAt, 0) : null;
  const isPending = iteration.result === "pending";

  const runTimestamp = iterationRun
    ? formatTime(iterationRun._id ? undefined : iteration.createdAt)
    : null;

  const actualToolCalls = iteration.actualToolCalls || [];

  return (
    <div className={cn("relative overflow-hidden", isPending && "opacity-60")}>
      <div
        className={cn(
          "absolute left-0 top-0 h-full w-1",
          getIterationBorderColor(iteration.result),
        )}
      />
      <div className="flex items-center gap-6 w-full">
        <div className="pl-3">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
        <button
          onClick={onToggle}
          className="flex flex-1 items-center gap-6 py-2.5 pr-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <span className="text-xs font-medium min-w-[120px] max-w-[120px] truncate">
            {testCase?.title || "—"}
          </span>
          <span className="text-xs text-muted-foreground min-w-[140px] max-w-[140px] truncate">
            {iteration.testCaseSnapshot?.model ||
              iterationTestCase?.model ||
              "—"}
          </span>
          <span className="text-xs font-mono text-muted-foreground min-w-[60px] max-w-[60px] text-right">
            {actualToolCalls.length}
          </span>
          <span className="text-xs font-mono text-muted-foreground min-w-[70px] max-w-[70px] text-right">
            {Number(iteration.tokensUsed || 0).toLocaleString()}
          </span>
          <span className="text-xs text-muted-foreground font-mono min-w-[70px] max-w-[70px] text-right">
            {durationMs !== null ? formatDuration(durationMs) : "—"}
          </span>
          {isPending && (
            <div className="flex items-center min-w-[40px]">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
            </div>
          )}
          {!isPending && iterationRun && onViewRun && (
            <div className="flex items-center min-w-[120px]">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 text-[11px] px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewRun(iterationRun._id);
                }}
              >
                View Run {formatRunId(iterationRun._id)}
              </Button>
            </div>
          )}
        </button>
      </div>
    </div>
  );
}
