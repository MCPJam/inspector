import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
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

/** The scorers this iteration ran, read from the run's own snapshot. */
export function iterationAuthored(
  iteration: EvalIteration,
  run: EvalSuiteRun | null,
) {
  return authoredForTrial({
    trial: { kind: "persisted", iteration, source: "route" },
    draft: { steps: [], toolsChoice: "unset" },
    run,
    forceSnapshot: true,
  }).authored;
}

/**
 * One iteration's chat, steps, scorecard and trace: the body of the
 * iteration drawer and of the Iteration page.
 */
export function IterationEvidence({
  iteration,
  listRun,
  run,
  chain,
  onEditEvaluator,
}: {
  iteration: EvalIteration;
  /** The run row the client identity comes from. */
  listRun: EvalSuiteRunListItem;
  /** The full run, for its snapshot of the case. */
  run: EvalSuiteRun | null;
  chain?: EvalRunDecisionChain;
  onEditEvaluator?: () => void;
}) {
  const result = computeIterationResult(iteration);
  const authored = iterationAuthored(iteration, run);
  return (
    <IterationDetails
      hostSnapshot={hostSnapshotFromStyle(runClientIdentity(listRun).hostStyle)}
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
              chain={chain}
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
  );
}
