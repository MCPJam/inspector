import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import { useSelectedRun } from "../../evals/use-selected-run";
import { runClientIdentity } from "../../evals/helpers";
import { computeIterationResult } from "../../evals/pass-criteria";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { IterationDetails } from "../../evals/iteration-details";
import { IterationReportScorecard } from "../case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import { outcomeLabel } from "./iteration-outcome";

/** The badge beside an iteration's title: its result, coloured. */
export function IterationOutcomeBadge({
  iteration,
}: {
  iteration: EvalIteration;
}) {
  const result = computeIterationResult(iteration);
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        result === "passed"
          ? "border-success/30 bg-success/10 text-success"
          : result === "failed" || result === "timed_out"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-border bg-muted text-muted-foreground",
      )}
    >
      {outcomeLabel(result)}
    </span>
  );
}

/**
 * One iteration's evidence: `IterationDetails` with the Evaluate scorecard.
 * The drawer and the Iteration page both render it, so they cannot disagree
 * about what an iteration shows.
 */
export function IterationReport({
  iteration,
  run,
  diagnostic,
  chain,
  onEditEvaluator,
}: {
  iteration: EvalIteration;
  /** The suite run the iteration belongs to. */
  run: EvalSuiteRunListItem;
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  onEditEvaluator?: () => void;
}) {
  const result = computeIterationResult(iteration);
  const fullRun = useSelectedRun(run.suiteId, run._id).run;
  const authored = authoredForTrial({
    trial: { kind: "persisted", iteration, source: "route" },
    draft: { steps: [], toolsChoice: "unset" },
    run:
      "tests" in (run.configSnapshot ?? {}) ? (run as EvalSuiteRun) : fullRun,
    forceSnapshot: true,
  }).authored;
  const decisionChain = diagnostic?.chain ?? chain;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <IterationDetails
        hostSnapshot={hostSnapshotFromStyle(runClientIdentity(run).hostStyle)}
        iteration={iteration}
        testCase={null}
        layoutMode="full"
        trialVerdictWord={outcomeLabel(result)}
        scorecard={{
          render: (context) => (
            <>
              <IterationReportScorecard
                authored={authored}
                iteration={iteration}
                steps={authored.steps}
                chain={decisionChain}
                envelope={context.envelope}
                trace={context.trace}
                scoresSection={context.scoresSection}
                judgeHidden={context.judgeHidden}
              />
              {onEditEvaluator && (
                <div className="mt-4 flex justify-end">
                  <Button onClick={onEditEvaluator}>
                    Configure test case evaluators
                  </Button>
                </div>
              )}
            </>
          ),
        }}
      />
    </div>
  );
}
