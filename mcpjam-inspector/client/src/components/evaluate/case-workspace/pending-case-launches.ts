import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { runIterationTargetKey } from "@/lib/eval-target-key";
import type { EvalIteration, EvalSuiteRunListItem } from "../../evals/types";

export type CaseLaunchScope = {
  projectId: string;
  suiteId: string;
  caseId: string;
};
export type CaseLaunchTarget = {
  client: string;
  model: string;
  hostId?: string;
  environmentId?: string;
  targetIndex?: number;
};
export type PendingCaseRow = EvalIteration &
  CaseLaunchTarget & {
    launchId: string;
    targetIndex: number;
  };
type CaseLaunch = CaseLaunchScope & {
  id: string;
  starting: boolean;
  rows: PendingCaseRow[];
};
export const useCaseLaunches = create<{ launches: CaseLaunch[] }>(() => ({
  launches: [],
}));
const sameScope = (a: CaseLaunchScope, b: CaseLaunchScope) =>
  a.projectId === b.projectId &&
  a.suiteId === b.suiteId &&
  a.caseId === b.caseId;
const update = (id: string, change: (launch: CaseLaunch) => CaseLaunch) =>
  useCaseLaunches.setState(({ launches }) => ({
    launches: launches
      .map((launch) => (launch.id === id ? change(launch) : launch))
      .filter((launch) => launch.starting || launch.rows.length > 0),
  }));

export const isPendingCaseRow = (row: EvalIteration): row is PendingCaseRow =>
  "launchId" in row;

export function beginCaseLaunch(
  scope: CaseLaunchScope,
  targets: CaseLaunchTarget[],
  count: number,
) {
  if (
    useCaseLaunches
      .getState()
      .launches.some((launch) => launch.starting && sameScope(launch, scope))
  )
    throw new Error(
      "This test case is already starting. Wait for it to start.",
    );
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const rows = targets.flatMap((target, targetIndex) =>
    Array.from({ length: count }, (_, index): PendingCaseRow => ({
      ...target,
      _id: `pending:${id}:${targetIndex}:${index}`,
      launchId: id,
      targetIndex: target.targetIndex ?? targetIndex,
      testCaseId: scope.caseId,
      projectId: scope.projectId,
      createdAt,
      updatedAt: createdAt,
      createdBy: "",
      iterationNumber: index + 1,
      status: "pending",
      result: "pending",
      actualToolCalls: [],
      tokensUsed: 0,
    })),
  );
  useCaseLaunches.setState(({ launches }) => ({
    launches: [...launches, { ...scope, id, starting: true, rows }],
  }));
  toast.loading("Starting run…", { id });
  return id;
}

export function resolveCaseLaunchEnvironments(
  id: string | undefined,
  environmentIds: string[],
) {
  if (id)
    update(id, (launch) => ({
      ...launch,
      rows: launch.rows.map((row) => ({
        ...row,
        environmentId: environmentIds[row.targetIndex],
      })),
    }));
}

export async function trackCaseLaunchTarget<T extends { runId?: string }>(
  id: string | undefined,
  targetIndex: number,
  request: Promise<T>,
): Promise<T> {
  try {
    const response = await request;
    if (id)
      update(id, (launch) => ({
        ...launch,
        rows: launch.rows.flatMap((row) =>
          row.targetIndex !== targetIndex
            ? [row]
            : response.runId
              ? [{ ...row, suiteRunId: response.runId }]
              : [],
        ),
      }));
    return response;
  } catch (error) {
    if (id)
      update(id, (launch) => ({
        ...launch,
        rows: launch.rows.filter((row) => row.targetIndex !== targetIndex),
      }));
    throw error;
  }
}

export function finishCaseLaunch(id: string, failed = false) {
  update(id, (launch) => ({
    ...launch,
    starting: false,
    rows: failed ? [] : launch.rows,
  }));
}

export function caseRowArrived(
  row: PendingCaseRow,
  iterations: EvalIteration[],
  runs: EvalSuiteRunListItem[],
) {
  return iterations.some((iteration) => {
    const run = runs.find((run) => run._id === iteration.suiteRunId);
    const sameRun = row.suiteRunId
      ? row.suiteRunId === iteration.suiteRunId
      : run?.runGroupId === row.launchId &&
        (row.environmentId
          ? run.configSnapshot.environmentRef?.environmentId ===
            row.environmentId
          : (run.namedHostId ?? "") === (row.hostId ?? ""));
    return (
      sameRun &&
      iteration.iterationNumber === row.iterationNumber &&
      (row.model === "Client default" ||
        runIterationTargetKey(run, iteration) === row.model)
    );
  });
}

export function usePendingCaseRows(
  scope: CaseLaunchScope | undefined,
  iterations: EvalIteration[],
  runs: EvalSuiteRunListItem[],
) {
  const launches = useCaseLaunches((state) => state.launches);
  const { projectId, suiteId, caseId } = scope ?? {};
  const rows = useMemo(
    () =>
      launches
        .filter(
          (launch) =>
            launch.projectId === projectId &&
            launch.suiteId === suiteId &&
            launch.caseId === caseId,
        )
        .flatMap((launch) => launch.rows),
    [launches, projectId, suiteId, caseId],
  );
  const arrived = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => caseRowArrived(row, iterations, runs))
          .map((row) => row._id),
      ),
    [rows, iterations, runs],
  );
  useEffect(() => {
    if (!arrived.size) return;
    for (const id of new Set(rows.map((row) => row.launchId)))
      update(id, (launch) => ({
        ...launch,
        rows: launch.rows.filter((row) => !arrived.has(row._id)),
      }));
  }, [arrived, rows]);
  return useMemo(
    () => rows.filter((row) => !arrived.has(row._id)),
    [rows, arrived],
  );
}
