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
  Play,
  Download,
  MoreHorizontal,
  TrendingUp,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@mcpjam/design-system/dropdown-menu";
import { formatRunId } from "../evals/helpers";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import { EvaluateRunCompare } from "./evaluate-run-compare";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { modelsFromRun } from "./run-launch-context";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

/** Hidden until we are ready to expose report export on this page. */
const SHOW_EXPORT_REPORT = false;

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
  useEffect(() => {
    setReviewing(false);
  }, [run._id]);
  const targets = launchRuns(run, relatedRuns ?? otherRuns);
  const [headerActions, setHeaderActions] =
    useState<EvaluateRunPageHeaderActions | null>(null);
  const [, setHeaderVerdict] = useState<HeaderVerdict | null>(null);
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
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="text-2xl font-bold leading-8 tracking-tight text-foreground">
                Run{" "}
                {targets[0].runNumber
                  ? `#${targets[0].runNumber}`
                  : formatRunId(targets[0]._id)}{" "}
                Results
              </h2>
              <RunPairingDecisions
                targets={targets}
                hostNamesById={hostNamesById}
                iterations={iterations}
              />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {SHOW_EXPORT_REPORT && onExport && (
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
              {launchReview && (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={Boolean(launchReview.disabledReason)}
                  title={launchReview.disabledReason ?? undefined}
                  onClick={() => setReviewing(true)}
                >
                  <Play className="size-3.5" aria-hidden />
                  Run again
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canCompare}
                title={
                  canCompare ? "Compare two runs" : "Need at least two runs"
                }
                onClick={() => setComparing(true)}
                data-testid="evaluate-run-compare-open"
              >
                <TrendingUp className="size-3.5" aria-hidden />
                Compare runs
              </Button>
              {(headerActions?.onImprove ||
                headerActions?.onOpenFailingTrace) && (
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
                    {headerActions.onImprove && (
                      <DropdownMenuItem
                        onSelect={headerActions.onImprove}
                        data-testid="run-verdict-improve"
                      >
                        <Copy aria-hidden /> Prompt to improve
                      </DropdownMenuItem>
                    )}
                    {headerActions.onOpenFailingTrace && (
                      <DropdownMenuItem
                        onSelect={headerActions.onOpenFailingTrace}
                        data-testid="run-verdict-open-trace"
                      >
                        <ArrowUpRight aria-hidden /> Open failing trace
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
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

function pairingClientName(
  target: EvalSuiteRun,
  hostNamesById: Map<string, string | null>,
): string {
  if (!target.namedHostId) return "Suite client";
  return (
    hostNamesById.get(target.namedHostId) ??
    `Client …${target.namedHostId.slice(-6)}`
  );
}

const IN_FLIGHT_STATUSES = new Set(["pending", "running", "grading"]);

export type PairingDecisionTone = "ship" | "hold" | "pending";

export type PairingDecision = {
  word: string;
  tone: PairingDecisionTone;
};

/**
 * Per-client decision for the run header. Uses the run's own stored verdict —
 * the same result the page already settled for that pairing — and never
 * invents Hold/Ship while the run is still in flight.
 */
export function pairingDecision(run: EvalSuiteRun): PairingDecision {
  const outcome = IN_FLIGHT_STATUSES.has(run.status)
    ? run.status
    : run.result && run.result !== "pending"
      ? run.result
      : run.status;
  if (outcome === "passed") return { word: "Ship", tone: "ship" };
  if (outcome === "failed" || outcome === "timed_out") {
    return { word: "Hold", tone: "hold" };
  }
  const labels: Record<string, string> = {
    running: "Running",
    grading: "Grading",
    pending: "Pending",
    cancelled: "Cancelled",
    inconclusive: "Inconclusive",
    completed: "Completed",
  };
  return { word: labels[outcome] ?? "Pending", tone: "pending" };
}

function pairingPillClass(tone: PairingDecisionTone): string {
  if (tone === "ship") return "border-success/30 bg-success/10 text-success";
  if (tone === "hold") return "border-warning/30 bg-warning/10 text-warning";
  return "border-border bg-muted/40 text-muted-foreground";
}

function pairingPillLabel(word: string, tone: PairingDecisionTone): string {
  return tone === "pending" ? word : word.toUpperCase();
}

const DECISION_PILL_ORDER: PairingDecisionTone[] = ["hold", "ship", "pending"];

type PairingMark = {
  key: string;
  label: string;
  client: string;
};

function pairingModel(
  target: EvalSuiteRun,
  iterations: readonly EvalIteration[] | undefined,
): string {
  const recovered = modelsFromRun(
    target,
    (iterations ?? []).filter((iteration) => iteration.suiteRunId === target._id),
  );
  return recovered[0] ?? "Client default";
}

function groupPairingsByDecision(
  targets: readonly EvalSuiteRun[],
  hostNamesById: Map<string, string | null>,
  iterations?: readonly EvalIteration[],
): Array<{
  tone: PairingDecisionTone;
  word: string;
  marks: PairingMark[];
}> {
  const buckets = new Map<
    PairingDecisionTone,
    { word: string; marks: PairingMark[] }
  >();
  for (const target of targets) {
    const decision = pairingDecision(target);
    const client = pairingClientName(target, hostNamesById);
    const model = pairingModel(target, iterations);
    const mark = {
      key: target._id,
      label: `${client} · ${model}`,
      client,
    };
    const bucket = buckets.get(decision.tone);
    if (!bucket) {
      buckets.set(decision.tone, { word: decision.word, marks: [mark] });
      continue;
    }
    bucket.marks.push(mark);
    if (decision.tone === "pending" && bucket.word !== decision.word) {
      bucket.word = "Pending";
    }
  }
  return DECISION_PILL_ORDER.flatMap((tone) => {
    const bucket = buckets.get(tone);
    return bucket ? [{ tone, ...bucket }] : [];
  });
}

function RunPairingDecisions({
  targets,
  hostNamesById,
  iterations,
}: {
  targets: readonly EvalSuiteRun[];
  hostNamesById: Map<string, string | null>;
  iterations?: readonly EvalIteration[];
}) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  const groups = groupPairingsByDecision(targets, hostNamesById, iterations);
  if (!groups.length) return null;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-testid="run-header-pairings"
    >
      {groups.map((group) => (
        <span
          key={group.tone}
          data-testid="run-header-decision-pill"
          data-decision={group.tone}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border py-0 pl-2.5 pr-1.5 text-[12px] font-medium",
            pairingPillClass(group.tone),
          )}
        >
          <span data-testid="run-header-pairing-decision">
            {pairingPillLabel(group.word, group.tone)}
          </span>
          <span className="flex items-center -space-x-1.5">
            {group.marks.map((mark) => (
              <Tooltip key={mark.key}>
                <TooltipTrigger asChild>
                  <span
                    aria-label={mark.label}
                    tabIndex={0}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-background"
                  >
                    <img
                      src={resolveHostLogoByName(mark.client, theme)}
                      alt=""
                      className="size-3.5 object-contain"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent variant="muted" aria-hidden="true">
                  {mark.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
