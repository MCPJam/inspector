import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import type { IterationTab } from "@/lib/eval-route-types";
import { runClientIdentity } from "../../evals/helpers";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { IterationDetails } from "../../evals/iteration-details";
import { setupScriptFailures } from "../../evals/code-grading/script-failures";
import { SetupFailedIteration } from "../../evals/code-grading/script-failure-cards";
import type { TraceDetailPlacement } from "../../evals/use-trace-detail-direction";
import { RunAccountsProvider } from "../../evals/run-accounts-context";
import { useSelectedRun } from "../../evals/use-selected-run";
import { IterationReportScorecard } from "../case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import type { TrialChainDisplay } from "../case-scorecard/trial-chain-state";
import { readRunExecutionEngine } from "../description-experiment-model";
import { iterationOutcome, outcomeLabel } from "./outcome";
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
  chainDisplay = "settled",
  onRetryChain,
  onEditEvaluator,
  onEditScripts,
  traceDetailPlacement,
  tab,
  onTabChange,
}: {
  iteration: EvalIteration;
  target: RunResultsMatrixData["targets"][number];
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  /** The chain read's state, so a failed read shows its retry, not a blank. */
  chainDisplay?: TrialChainDisplay;
  onRetryChain?: () => void;
  onEditEvaluator?: () => void;
  /** Opens suite settings from a failed setup or cleanup script's card. */
  onEditScripts?: () => void;
  traceDetailPlacement?: TraceDetailPlacement;
  tab?: IterationTab;
  onTabChange?: (tab: IterationTab) => void;
}) {
  const result = iterationOutcome(iteration);
  const fullRun = useSelectedRun(target.run.suiteId, target.run._id).run;
  // The agent never ran: no transcript or scorecard to tab between.
  const setupFailures = setupScriptFailures(iteration, fullRun);
  if (setupFailures.length > 0) {
    return (
      <SetupFailedIteration
        failures={setupFailures}
        onEditScripts={onEditScripts}
      />
    );
  }
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
      testCaseId={iteration.testCaseId}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <IterationDetails
          hostSnapshot={hostSnapshotFromStyle(
            runClientIdentity(target.run).hostStyle,
          )}
          iteration={iteration}
          testCase={null}
          layoutMode="full"
          executionEngine={
            target.run.configSnapshot?.executionEngine ||
            (fullRun ? readRunExecutionEngine(fullRun) : undefined)
          }
          traceDetailPlacement={traceDetailPlacement}
          // A link without a tab opens on the scorecard, even after an
          // in-page click moved the tab elsewhere.
          activeTab={onTabChange ? (modeForTab(tab) ?? "scorecard") : undefined}
          onTabChange={onTabChange && ((mode) => onTabChange(tabForMode(mode)))}
          trialVerdictWord={outcomeLabel(result)}
          onEditScripts={onEditScripts}
          codeEvaluators={fullRun?.configSnapshot?.codeEvaluators}
          scorecard={{
            render: (context) => (
              <>
                <IterationReportScorecard
                  authored={authored}
                  iteration={iteration}
                  steps={authored.steps}
                  chain={decisionChain}
                  chainDisplay={diagnostic?.chain ? "settled" : chainDisplay}
                  onRetryChain={onRetryChain}
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
