import { History } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import { summarizeTrialChain } from "../stage-trial-model";
import { groupCaseIterations } from "../../evals/runs/group-case-iterations";
import { CaseRunsHistory } from "../../evals/runs/case-runs-history";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import {
  trialActivity,
  trialVerdict,
  type SelectedTrial,
} from "./selected-trial";

const VERDICT_TONE_CLASS: Record<
  ReturnType<typeof trialVerdict>["tone"],
  string
> = {
  pending: "bg-pending/50 text-pending-foreground",
  success: "bg-success/50 text-foreground",
  destructive: "bg-destructive/50 text-destructive-foreground",
  muted: "bg-muted text-muted-foreground",
};

export function TrialHeader({
  trial,
  chain,
  run,
  judgeCase,
  iterations,
  suiteRuns,
  hostNamesById,
  defaultHostLabel,
  hasHostAttachments,
  onSelectIteration,
}: {
  trial: SelectedTrial | null;
  chain?: EvalRunDecisionChain | null;
  run?: Pick<EvalSuiteRun, "status" | "goalCompletionStatus"> | null;
  judgeCase?: { status?: string } | null;
  iterations: EvalIteration[];
  suiteRuns?: EvalSuiteRun[];
  hostNamesById?: Map<string, string | null>;
  defaultHostLabel?: string | null;
  hasHostAttachments?: boolean;
  onSelectIteration: (iteration: EvalIteration) => void;
}) {
  const verdict = trial ? trialVerdict(trial) : null;
  const activity = trialActivity({ run, judgeCase });
  const summary = chain ? summarizeTrialChain(chain) : null;
  // Newest batch first; "N trials complete" describes that batch, not the
  // whole history.
  const batches = groupCaseIterations(iterations);
  const completedCount = (batches[0]?.iterations ?? []).filter(
    (iteration) =>
      iteration.status === "completed" ||
      iteration.result === "passed" ||
      iteration.result === "failed",
  ).length;
  const selectedIterationId =
    trial?.kind === "persisted"
      ? trial.iteration._id
      : (trial?.record.iteration?._id ?? null);

  return (
    <header
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2"
      data-testid="case-workspace-trial-header"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {verdict ? (
          <span
            className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              VERDICT_TONE_CLASS[verdict.tone],
            )}
            data-testid="case-workspace-trial-verdict"
          >
            {verdict.word}
          </span>
        ) : null}
        {activity ? (
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="case-workspace-trial-activity"
          >
            {activity}
          </span>
        ) : null}
        {summary ? (
          <span
            className={cn("truncate text-[11px]", summary.toneClass)}
            data-testid="case-workspace-trial-chain"
          >
            {summary.label}
          </span>
        ) : null}
        {completedCount > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            {completedCount} iteration{completedCount === 1 ? "" : "s"} complete
          </span>
        ) : null}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            data-testid="case-workspace-history"
          >
            <History className="h-3.5 w-3.5" />
            History
            {batches.length > 0 ? (
              <span className="tabular-nums text-[10px]">{batches.length}</span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" className="w-[22rem] p-0">
          <div className="max-h-[22rem] overflow-y-auto">
            <CaseRunsHistory
              iterations={iterations}
              selectedIterationId={selectedIterationId}
              suiteRuns={suiteRuns}
              hostNamesById={hostNamesById}
              defaultHostLabel={defaultHostLabel}
              hasHostAttachments={hasHostAttachments}
              onSelectIteration={onSelectIteration}
            />
          </div>
        </PopoverContent>
      </Popover>
    </header>
  );
}
