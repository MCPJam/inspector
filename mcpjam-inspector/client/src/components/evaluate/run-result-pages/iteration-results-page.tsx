import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import type { ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { IterationTab } from "@/lib/eval-route-types";
import { formatRelativeTime, formatRunId } from "../../evals/helpers";
import { computeIterationResult } from "../../evals/pass-criteria";
import type { EvalIteration } from "../../evals/types";
import type { TrialChainDisplay } from "../case-scorecard/trial-chain-state";
import { IterationReport } from "./iteration-report";
import { IterationResultBadge, ResultPageTitle } from "./result-page-parts";
import type { MatrixTarget } from "./result-page-links";

export function IterationResultsPage({
  iteration,
  iterationNumber,
  target,
  diagnostic,
  chain,
  chainDisplay,
  onRetryChain,
  onEditCase,
  pager,
  tab,
  onTabChange,
}: {
  iteration: EvalIteration;
  iterationNumber: number;
  target: MatrixTarget;
  diagnostic?: EvalRunDecisionDiagnostic;
  chain?: EvalRunDecisionChain;
  chainDisplay?: TrialChainDisplay;
  onRetryChain?: () => void;
  onEditCase?: () => void;
  pager?: ReactNode;
  tab?: IterationTab;
  onTabChange?: (tab: IterationTab) => void;
}) {
  return (
    // A fixed-height flex column: the Trace tab collapses in a scrolling page.
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="iteration-results-page"
    >
      <ResultPageTitle
        title={`Iteration #${iterationNumber}`}
        badge={
          <IterationResultBadge result={computeIterationResult(iteration)} />
        }
        meta={
          <>
            {target.client} · {target.model} ·{" "}
            {formatRelativeTime(
              iteration.createdAt ?? iteration.startedAt ?? iteration.updatedAt,
            )}{" "}
            · {formatRunId(iteration._id)}
          </>
        }
        actions={
          <>
            {pager}
            {onEditCase ? (
              <Button onClick={onEditCase}>Edit test case</Button>
            ) : null}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-4">
        <IterationReport
          iteration={iteration}
          target={target}
          diagnostic={diagnostic}
          chain={chain}
          chainDisplay={chainDisplay}
          onRetryChain={onRetryChain}
          traceDetailPlacement="auto"
          tab={tab}
          onTabChange={onTabChange}
        />
      </div>
    </div>
  );
}
