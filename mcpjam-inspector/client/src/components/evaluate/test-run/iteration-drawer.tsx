import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { hostSnapshotFromStyle } from "@/lib/host-snapshot";
import {
  formatRelativeTime,
  formatRunId,
  runClientIdentity,
} from "../../evals/helpers";
import { computeIterationResult } from "../../evals/pass-criteria";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import { IterationDetails } from "../../evals/iteration-details";
import { useSelectedRun } from "../../evals/use-selected-run";
import { IterationReportScorecard } from "../case-scorecard/iteration-report-subscriber";
import { authoredForTrial } from "../case-scorecard/trial-authored";
import { EvalInspectBody, EvalInspectHeader } from "../eval-inspect-sheet";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import { outcomeLabel } from "./iteration-outcome";

export function IterationDrawer({
  iteration,
  iterationNumber,
  target,
  caseTitle,
  suiteName,
  diagnostic,
  chain,
  onBack,
  onEditEvaluator,
}: {
  iteration: EvalIteration;
  iterationNumber: number;
  target: RunResultsMatrixData["targets"][number];
  caseTitle: string;
  suiteName?: string;
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  onBack: () => void;
  onEditEvaluator?: () => void;
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
    <>
      <EvalInspectHeader
        crumb={
          <>
            {caseTitle} <span aria-hidden="true">›</span> Run #
            {target.run.runNumber}
          </>
        }
        onBack={onBack}
        backAriaLabel="Back to test case iterations"
        title={`#${iterationNumber} ${suiteName ?? target.run.name ?? "Run"}`}
        badge={
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
        }
        description={
          <>
            {target.client} · {target.model} ·{" "}
            {formatRelativeTime(
              iteration.createdAt ?? iteration.startedAt ?? iteration.updatedAt,
            )}{" "}
            · {formatRunId(iteration._id)}
          </>
        }
      />
      {/* `fill` keeps IterationDetails / TraceViewer in a definite flex
          height so the Trace tab paints instead of collapsing to the resize
          handle. */}
      <EvalInspectBody fill>
        <div className="flex min-h-0 flex-1 flex-col">
          <IterationDetails
            hostSnapshot={hostSnapshotFromStyle(
              runClientIdentity(target.run).hostStyle,
            )}
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
      </EvalInspectBody>
    </>
  );
}
