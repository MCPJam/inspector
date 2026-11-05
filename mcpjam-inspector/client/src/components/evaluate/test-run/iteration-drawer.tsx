import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import { formatRelativeTime, formatRunId } from "../../evals/helpers";
import type { EvalIteration } from "../../evals/types";
import { EvalInspectBody, EvalInspectHeader } from "../eval-inspect-sheet";
import type { RunResultsMatrixData } from "../run-results-matrix-model";
import { IterationOutcomeBadge, IterationReport } from "./iteration-report";

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
        badge={<IterationOutcomeBadge iteration={iteration} />}
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
        <IterationReport
          iteration={iteration}
          run={target.run}
          diagnostic={diagnostic}
          chain={chain}
          onEditEvaluator={onEditEvaluator}
        />
      </EvalInspectBody>
    </>
  );
}
