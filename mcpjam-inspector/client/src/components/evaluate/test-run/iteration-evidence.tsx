import type { ReactNode } from "react";
import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import { runClientIdentity } from "../../evals/helpers";
import { computeIterationResult } from "../../evals/pass-criteria";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../evals/types";
import { useSelectedRun } from "../../evals/use-selected-run";
import { IterationDetails } from "../../evals/iteration-details";
import { IterationReportScorecard } from "../case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import { outcomeLabel } from "./case-iterations";

/** One recorded iteration's evidence: IterationDetails with its scorecard. */
export function IterationEvidence({
  iteration,
  run,
  diagnostic,
  chain,
  scorecardFooter,
}: {
  iteration: EvalIteration;
  /** The iteration's own run (a launch sibling, not always the address's run). */
  run: EvalSuiteRun | EvalSuiteRunListItem;
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  /** Rendered under the scorecard. */
  scorecardFooter?: ReactNode;
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
              {scorecardFooter}
            </>
          ),
        }}
      />
    </div>
  );
}
