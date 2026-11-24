import { makeFunctionReference } from "convex/server";
import { useQuery } from "convex/react";
import { Progress } from "@mcpjam/design-system/progress";

const runGroupsQuery = makeFunctionReference<"query">("climbs:getClimbRunGroups");
const runQuery = makeFunctionReference<"query">("testSuites:getTestSuiteRun");

type RunGroup = {
  unitKey: string;
  role: string;
  runGroupId: string;
  environmentIds: string[];
  launchedRunIds: string[];
};

type RunDoc = {
  status?: string;
  summary?: { total: number; passed: number; failed: number };
  configSnapshot?: { environmentRef?: { environmentId: string } };
};

function RunLine({
  runId,
  position,
  of,
  labels,
}: {
  runId: string;
  position: number;
  of: number;
  labels: Record<string, string>;
}) {
  const run = useQuery(runQuery, { runId }) as RunDoc | null | undefined;
  const environmentId = run?.configSnapshot?.environmentRef?.environmentId;
  const name = (environmentId && labels[environmentId]) || "Environment";
  const total = run?.summary?.total ?? 0;
  const done = (run?.summary?.passed ?? 0) + (run?.summary?.failed ?? 0);
  const finished = run?.status === "completed" || run?.status === "failed";
  const value = finished ? 100 : total > 0 ? Math.round((done / total) * 100) : 0;
  const detail = run === undefined
    ? "Loading"
    : total > 0
      ? `${done} of ${total} iterations`
      : finished
        ? "Finished"
        : "Starting";
  return (
    <div className="flex flex-col gap-1.5" data-testid="run-progress-line">
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-medium">{name}</span>
        <span className="tabular-nums text-muted-foreground">
          {of > 1 ? `Run ${position} of ${of} · ` : ""}
          {detail}
        </span>
      </div>
      <Progress value={value} aria-label={`${name}, run ${position}`} />
    </div>
  );
}

/** One line a run of the unit in flight: how many iterations of it have finished. */
export function UnitProgress({
  climbId,
  unitKey,
  labels,
}: {
  climbId: string;
  unitKey: string | undefined;
  labels: Record<string, string>;
}) {
  const groups = useQuery(runGroupsQuery, { climbId }) as RunGroup[] | undefined;
  const unit = (groups ?? []).filter((group) => group.unitKey === unitKey);
  if (groups === undefined) {
    return <p className="text-sm text-muted-foreground">Loading progress.</p>;
  }
  const lines = unit.flatMap((group, index) =>
    group.launchedRunIds.map((runId) => ({ runId, position: index + 1 })),
  );
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">The runs are starting.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {lines.map((line) => (
        <RunLine
          key={line.runId}
          runId={line.runId}
          position={line.position}
          of={unit.length}
          labels={labels}
        />
      ))}
    </div>
  );
}
