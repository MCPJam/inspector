import {
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
} from "@mcpjam/sdk/contract";
import type { FindingProblem } from "@/lib/insights-envelope-api";
import type { AffectedIterationRow } from "./affected-iterations-list";

/** A measured failure location, never a cause inferred from the error prose. */
export function ProblemRubric({
  problem,
  iterationRows,
}: {
  problem: Pick<FindingProblem, "iterationIds" | "affected">;
  iterationRows: Record<string, AffectedIterationRow>;
}) {
  const stages = USER_VALUE_STAGES.flatMap((stage) => {
    const count = problem.iterationIds.filter((id) => {
      const chain = iterationRows[id]?.chain;
      return chain?.status === "verified" && chain.firstFailedStage === stage;
    }).length;
    return count ? [{ stage, count }] : [];
  });
  const known = stages.reduce((sum, row) => sum + row.count, 0);
  return (
    <>
      <li>
        <strong>Value chain:</strong>{" "}
        {stages.length
          ? stages
              .map(
                ({ stage, count }) =>
                  `${USER_VALUE_STAGE_LABELS[stage]} failed first in ${count} of ${problem.affected.count} affected iterations`,
              )
              .join("; ")
          : "Failure stage not established."}
        {known > 0 && known < problem.affected.count
          ? `. Failure stage unconfirmed for ${problem.affected.count - known}.`
          : ""}
      </li>
      {stages.length === 1 ? (
        <li>
          <strong>Expected:</strong>{" "}
          {USER_VALUE_STAGE_OUTCOMES[stages[0].stage]}.
        </li>
      ) : null}
    </>
  );
}
