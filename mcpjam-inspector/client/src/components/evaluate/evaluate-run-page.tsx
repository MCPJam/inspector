/**
 * Evaluate (New) run page — this run only, plus Compare.
 *
 * The shipped Evaluate tab still folds a selected run into SuiteResultsSplit
 * (All runs + the rail). This page is the opt-in replacement: no rail, no
 * other-run list. Compare is a picker ({@link EvaluateRunCompare}) that then
 * uses the existing `compareToRunId` route / RunDiffView.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { ArrowUpRight, Copy, GitCompareArrows } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  evalSurfaceCardClass,
  evalSurfaceHeaderClass,
} from "../evals/eval-surface-chrome";
import { formatRunId } from "../evals/helpers";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import { EvaluateRunCompare } from "./evaluate-run-compare";
import { RunLaunchContext } from "./run-launch-context";

export type EvaluateRunPageHeaderActions = {
  onImprove?: () => void;
  onOpenFailingTrace?: () => void;
};

const HeaderActionsContext = createContext<
  ((actions: EvaluateRunPageHeaderActions | null) => void) | null
>(null);

/** Lift Prompt-to-improve / Open-failing-trace into this page's header. */
export function useEvaluateRunPageHeaderActions(
  actions: EvaluateRunPageHeaderActions | null,
) {
  const setActions = useContext(HeaderActionsContext);
  const onImprove = actions?.onImprove;
  const onOpenFailingTrace = actions?.onOpenFailingTrace;
  useLayoutEffect(() => {
    if (!setActions) return;
    setActions(
      onImprove || onOpenFailingTrace
        ? {
            ...(onImprove ? { onImprove } : {}),
            ...(onOpenFailingTrace ? { onOpenFailingTrace } : {}),
          }
        : null,
    );
    return () => setActions(null);
  }, [setActions, onImprove, onOpenFailingTrace]);
  return Boolean(setActions);
}

export function EvaluateRunPage({
  run,
  hostNamesById,
  otherRuns,
  defaultCompareRunId,
  onCompareWithRun,
  onExport,
  iterations,
  children,
}: {
  run: EvalSuiteRun;
  hostNamesById: Map<string, string | null>;
  otherRuns: readonly EvalSuiteRun[];
  defaultCompareRunId: string | null;
  onCompareWithRun: (baseRunId: string) => void;
  onExport?: () => void;
  /** Used to recover the model when the list projection omitted effectiveModelId. */
  iterations?: readonly EvalIteration[];
  children: ReactNode;
}) {
  const [comparing, setComparing] = useState(false);
  const [headerActions, setHeaderActions] =
    useState<EvaluateRunPageHeaderActions | null>(null);
  const canCompare = otherRuns.length >= 1;

  return (
    <HeaderActionsContext.Provider value={setHeaderActions}>
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
            "flex flex-col gap-2.5 border-border/30 bg-transparent px-5 py-3.5",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="font-mono text-[15px] font-semibold tracking-tight text-foreground">
                Run {formatRunId(run._id)}
              </h2>
              <RunOutcomeBadge run={run} />
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {headerActions?.onImprove ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-8"
                  onClick={headerActions.onImprove}
                  data-testid="run-verdict-improve"
                >
                  <Copy className="h-4 w-4" />
                  Prompt to improve
                </Button>
              ) : null}
              {headerActions?.onOpenFailingTrace ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={headerActions.onOpenFailingTrace}
                  data-testid="run-verdict-open-trace"
                >
                  Open failing trace
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Button>
              ) : null}
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
          <RunLaunchContext
            run={run}
            hostNamesById={hostNamesById}
            iterations={iterations}
          />
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
    </HeaderActionsContext.Provider>
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
