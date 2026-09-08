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
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { SuiteRunReview, type SuiteRunReviewProps } from "./suite-run-review";
import type { RunVerdictHeroView } from "./run-verdict-hero-model";
import { launchRuns } from "./run-results-matrix-model";
import {
  ArrowUpRight,
  Copy,
  GitCompareArrows,
  Play,
  Download,
  MoreHorizontal,
  Info,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@mcpjam/design-system/sheet";
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

type HeaderVerdict = RunVerdictHeroView["verdict"];
const HeaderVerdictContext = createContext<
  ((verdict: HeaderVerdict | null) => void) | null
>(null);

export function useRunHeaderVerdict(verdict: HeaderVerdict) {
  const setVerdict = useContext(HeaderVerdictContext);
  const { word, tone, undecidedLine } = verdict;
  useLayoutEffect(() => {
    if (!setVerdict) return;
    setVerdict({ word, tone, undecidedLine });
    return () => setVerdict(null);
  }, [setVerdict, word, tone, undecidedLine]);
  return Boolean(setVerdict);
}

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
  relatedRuns,
  defaultCompareRunId,
  onCompareWithRun,
  onExport,
  iterations,
  launchReview,
  children,
}: {
  run: EvalSuiteRun;
  hostNamesById: Map<string, string | null>;
  otherRuns: readonly EvalSuiteRun[];
  relatedRuns?: readonly EvalSuiteRun[];
  defaultCompareRunId: string | null;
  onCompareWithRun: (baseRunId: string) => void;
  onExport?: () => void;
  /** Used to recover the model when the list projection omitted effectiveModelId. */
  iterations?: readonly EvalIteration[];
  launchReview?: Omit<SuiteRunReviewProps, "onClose">;
  children: ReactNode;
}) {
  const [comparing, setComparing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    setReviewing(false);
    setShowDetails(false);
  }, [run._id]);
  const targets = launchRuns(run, relatedRuns ?? otherRuns);
  const [headerActions, setHeaderActions] =
    useState<EvaluateRunPageHeaderActions | null>(null);
  const [headerVerdict, setHeaderVerdict] = useState<HeaderVerdict | null>(
    null,
  );
  const canCompare = otherRuns.length >= 1;

  return (
    <HeaderActionsContext.Provider value={setHeaderActions}>
      <HeaderVerdictContext.Provider value={setHeaderVerdict}>
        <section
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
          data-testid="evaluate-run-page"
        >
          <header
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4"
            data-testid="evaluate-run-header"
          >
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                Run{" "}
                {targets[0].runNumber
                  ? `#${targets[0].runNumber}`
                  : formatRunId(targets[0]._id)}{" "}
                Results
              </h2>
              {headerVerdict && (
                <span
                  data-testid="run-header-verdict"
                  title={headerVerdict.undecidedLine ?? undefined}
                  className={cn(
                    "rounded border px-2 py-0.5 text-[11px] font-medium",
                    headerVerdict.tone === "passed"
                      ? "border-success/30 bg-success/10"
                      : headerVerdict.tone === "failed"
                      ? "border-destructive/30 bg-destructive/10"
                      : headerVerdict.tone === "caution"
                      ? "border-warning/30 bg-warning/10"
                      : "border-border bg-muted/40",
                  )}
                >
                  {headerVerdict.word}
                </span>
              )}
              {targets.length === 1 && !headerVerdict ? (
                <RunOutcomeBadge run={run} />
              ) : targets.length > 1 ? (
                <span className="text-xs text-muted-foreground">
                  {targets.length} client/model pairings
                </span>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {onExport && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onExport}
                >
                  <Download className="size-3.5" aria-hidden />
                  Export report
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Run actions"
                  >
                    <MoreHorizontal className="size-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {launchReview && (
                    <DropdownMenuItem
                      disabled={Boolean(launchReview.disabledReason)}
                      title={launchReview.disabledReason ?? undefined}
                      onSelect={() => setReviewing(true)}
                    >
                      <Play aria-hidden /> New run
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={!canCompare}
                    title={
                      canCompare ? "Compare two runs" : "Need at least two runs"
                    }
                    onSelect={() => setComparing(true)}
                    data-testid="evaluate-run-compare-open"
                  >
                    <GitCompareArrows aria-hidden /> Compare runs
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setShowDetails(true)}>
                    <Info aria-hidden /> Run details
                  </DropdownMenuItem>
                  {(headerActions?.onImprove ||
                    headerActions?.onOpenFailingTrace) && (
                    <DropdownMenuSeparator />
                  )}
                  {headerActions?.onImprove && (
                    <DropdownMenuItem
                      onSelect={headerActions.onImprove}
                      data-testid="run-verdict-improve"
                    >
                      <Copy aria-hidden /> Prompt to improve
                    </DropdownMenuItem>
                  )}
                  {headerActions?.onOpenFailingTrace && (
                    <DropdownMenuItem
                      onSelect={headerActions.onOpenFailingTrace}
                      data-testid="run-verdict-open-trace"
                    >
                      <ArrowUpRight aria-hidden /> Open failing trace
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

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
          <Sheet open={showDetails} onOpenChange={setShowDetails}>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Run details</SheetTitle>
                <SheetDescription>
                  The client, models, and servers used for this report.
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 py-5">
                <div className="space-y-5">
                  {targets.map((target) => (
                    <RunLaunchContext
                      key={target._id}
                      run={target}
                      hostNamesById={hostNamesById}
                      iterations={iterations?.filter(
                        (item) => item.suiteRunId === target._id,
                      )}
                    />
                  ))}
                </div>
              </div>
            </SheetContent>
          </Sheet>
          {reviewing && launchReview && (
            <SuiteRunReview
              {...launchReview}
              onClose={() => setReviewing(false)}
            />
          )}
        </section>
      </HeaderVerdictContext.Provider>
    </HeaderActionsContext.Provider>
  );
}

function RunOutcomeBadge({ run }: { run: EvalSuiteRun }) {
  const outcome = ["pending", "running", "grading"].includes(run.status)
    ? run.status
    : run.result && run.result !== "pending"
    ? run.result
    : run.status;
  const labels: Record<string, string> = {
    passed: "Passed",
    failed: "Failed",
    inconclusive: "Inconclusive",
    completed: "Completed",
    running: "Running",
    grading: "Grading",
    cancelled: "Cancelled",
    timed_out: "Timed out",
    pending: "Pending",
  };
  const label = labels[outcome] ?? "Unknown";
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
