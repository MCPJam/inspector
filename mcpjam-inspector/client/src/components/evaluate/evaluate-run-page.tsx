/**
 * Evaluate (New) run page — this run only, plus Compare.
 *
 * The shipped Evaluate tab still folds a selected run into SuiteResultsSplit
 * (All runs + the rail). This page is the opt-in replacement: no rail, no
 * other-run list. Compare is a picker ({@link EvaluateRunCompare}) that then
 * uses the existing `compareToRunId` route / RunDiffView.
 */
import { useState, type ReactNode } from "react";
import { GitCompareArrows } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "../evals/eval-surface-chrome";
import { formatRunId } from "../evals/helpers";
import { RunContextChip } from "../evals/run-context-chip";
import type { EvalSuiteRun } from "../evals/types";
import { EvaluateRunCompare } from "./evaluate-run-compare";

export function EvaluateRunPage({
  run,
  hostNamesById,
  otherRuns,
  defaultCompareRunId,
  onCompareWithRun,
  onExport,
  children,
}: {
  run: EvalSuiteRun;
  hostNamesById: Map<string, string | null>;
  otherRuns: readonly EvalSuiteRun[];
  defaultCompareRunId: string | null;
  onCompareWithRun: (baseRunId: string) => void;
  onExport?: () => void;
  children: ReactNode;
}) {
  const [comparing, setComparing] = useState(false);
  const canCompare = otherRuns.length >= 1;

  return (
    <section
      className={cn(
        evalSurfaceCardClass,
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/35 dark:bg-muted/20",
      )}
      data-testid="evaluate-run-page"
    >
      <div
        className={cn(
          evalSurfaceHeaderClass,
          "flex flex-wrap items-center justify-between gap-3 border-border/30 bg-transparent px-5 py-3.5",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="font-mono text-[15px] font-semibold tracking-tight text-foreground">
            Run {formatRunId(run._id)}
          </h2>
          <RunOutcomeBadge run={run} />
          <RunContextChip
            run={run}
            hostNamesById={hostNamesById}
            className="gap-1 px-2 py-0.5 text-[11px] shadow-none"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onExport ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onExport}
            >
              Export
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!canCompare}
            title={
              canCompare ? "Compare two runs" : "Need at least two runs"
            }
            onClick={() => setComparing(true)}
            data-testid="evaluate-run-compare-open"
          >
            <GitCompareArrows className="h-4 w-4" />
            Compare runs
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
        {comparing ? (
          <EvaluateRunCompare
            thisRun={run}
            otherRuns={otherRuns}
            defaultOtherRunId={defaultCompareRunId}
            hostNamesById={hostNamesById}
            onSelect={(baseRunId) => {
              setComparing(false);
              onCompareWithRun(baseRunId);
            }}
            onCancel={() => setComparing(false)}
          />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function RunOutcomeBadge({ run }: { run: EvalSuiteRun }) {
  const outcome = run.result ?? run.status;
  const label =
    outcome === "passed"
      ? "Passed"
      : outcome === "failed"
        ? "Failed"
        : outcome === "running"
          ? "Running"
          : outcome === "cancelled"
            ? "Cancelled"
            : "Pending";
  const tone =
    outcome === "passed"
      ? "bg-success/10 text-success"
      : outcome === "failed"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  );
}
