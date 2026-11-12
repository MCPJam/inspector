import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import type { IterationTab } from "@/lib/eval-route-types";
import { runClientIdentity } from "../../evals/helpers";
import { computeIterationResult } from "../../evals/pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { IterationDetails } from "../../evals/iteration-details";
import type { TraceDetailPlacement } from "../../evals/use-trace-detail-direction";
import { RunAccountsProvider } from "../../evals/run-accounts-context";
import { useSelectedRun } from "../../evals/use-selected-run";
import { IterationReportScorecard } from "../case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import { outcomeLabel } from "./outcome";
import { modeForTab, tabForMode } from "./iteration-tab";

/**
 * One iteration's full report: tabs, scorecard and trace. The caller gives it
 * a definite flex height so the Trace tab paints instead of collapsing.
 */
export function IterationReport({
  iteration,
  target,
  diagnostic,
  chain,
  onEditEvaluator,
  traceDetailPlacement,
  tab,
  onTabChange,
}: {
  iteration: EvalIteration;
  target: RunResultsMatrixData["targets"][number];
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  onEditEvaluator?: () => void;
  traceDetailPlacement?: TraceDetailPlacement;
  tab?: IterationTab;
  onTabChange?: (tab: IterationTab) => void;
}) {
  const result = computeIterationResult(iteration);
  const fullRun = useSelectedRun(target.run.suiteId, target.run._id).run;
  const authored = authoredForTrial({
    trial: { kind: "persisted", iteration, source: "route" },
    draft: { steps: [], toolsChoice: "unset" },
    run:
      "tests" in (target.run.configSnapshot ?? {})
        ? (target.run as EvalSuiteRun)
        : fullRun,
    forceSnapshot: true,
  }).authored;
  const decisionChain = diagnostic?.chain ?? chain;

  return (
    // The trace below names the account each tool call ran on.
    <RunAccountsProvider
      accounts={target.run.accountsAtRun ?? fullRun?.accountsAtRun}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <IterationDetails
          hostSnapshot={hostSnapshotFromStyle(
            runClientIdentity(target.run).hostStyle,
          )}
          iteration={iteration}
          testCase={null}
          layoutMode="full"
          traceDetailPlacement={traceDetailPlacement}
          activeTab={modeForTab(tab)}
          onTabChange={onTabChange && ((mode) => onTabChange(tabForMode(mode)))}
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
    </RunAccountsProvider>
  );
}
