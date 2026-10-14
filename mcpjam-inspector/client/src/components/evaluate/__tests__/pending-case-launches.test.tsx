import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { EvalIteration, EvalSuiteRunListItem } from "../../evals/types";
import {
  beginCaseLaunch,
  finishCaseLaunch,
  resolveCaseLaunchEnvironments,
  trackCaseLaunchTarget,
  useCaseLaunches,
  usePendingCaseRows,
} from "../case-workspace/pending-case-launches";

vi.mock("sonner", () => ({ toast: { loading: vi.fn() } }));
const scope = { projectId: "project", suiteId: "suite", caseId: "case" };
const targets = [
  {
    client: "Claude",
    hostId: "claude",
    model: "model",
    environmentId: "env-a",
  },
  {
    client: "ChatGPT",
    hostId: "chatgpt",
    model: "model",
    environmentId: "env-b",
  },
];
const realRow = (runId: string, iterationNumber = 1): EvalIteration => ({
  _id: `${runId}:${iterationNumber}`,
  suiteRunId: runId,
  testCaseId: scope.caseId,
  targetKey: "model",
  createdAt: 10,
  updatedAt: 10,
  createdBy: "user",
  iterationNumber,
  status: "running",
  result: "pending",
  actualToolCalls: [],
  tokensUsed: 0,
});
const run = (id: string, group: string, environmentId: string) =>
  ({
    _id: id,
    runGroupId: group,
    effectiveModelId: "model",
    configSnapshot: { environmentRef: { environmentId } },
  }) as EvalSuiteRunListItem;

describe("pending case launches", () => {
  beforeEach(() => useCaseLaunches.setState({ launches: [] }));

  it("keeps one row per target and repetition across case switches and remounts", () => {
    const id = beginCaseLaunch(scope, targets, 2);
    const { result, rerender, unmount } = renderHook(
      ({ current }) => usePendingCaseRows(current, [], []),
      { initialProps: { current: scope } },
    );
    expect(result.current).toHaveLength(4);
    expect(result.current.map((row) => row.iterationNumber)).toEqual([
      1, 2, 1, 2,
    ]);
    for (const current of [
      { ...scope, caseId: "other" },
      { ...scope, suiteId: "other" },
      { ...scope, projectId: "other" },
    ]) {
      rerender({ current });
      expect(result.current).toHaveLength(0);
    }
    unmount();
    const remount = renderHook(() => usePendingCaseRows(scope, [], []));
    expect(remount.result.current).toHaveLength(4);
    expect(() => beginCaseLaunch(scope, targets, 1)).toThrow(
      "already starting",
    );
    act(() => finishCaseLaunch(id, true));
    expect(remount.result.current).toHaveLength(0);
  });

  it("replaces rows before responses arrive and never puts them back", async () => {
    const id = beginCaseLaunch(scope, targets, 2);
    resolveCaseLaunchEnvironments(id, ["resolved-a", "resolved-b"]);
    const iterations = [realRow("a")];
    const { result, rerender } = renderHook(
      ({ rows, runs }) => usePendingCaseRows(scope, rows, runs),
      {
        initialProps: { rows: iterations, runs: [run("a", id, "resolved-a")] },
      },
    );
    expect(result.current).toHaveLength(3);
    expect(
      result.current
        .filter((row) => row.targetIndex === 0)
        .map((row) => row.iterationNumber),
    ).toEqual([2]);
    await act(() =>
      trackCaseLaunchTarget(id, 0, Promise.resolve({ runId: "a" })),
    );
    expect(result.current).toHaveLength(3);
    rerender({ rows: [...iterations, realRow("a", 2)], runs: [] });
    expect(result.current).toHaveLength(2);
    expect(result.current.every((row) => row.targetIndex === 1)).toBe(true);
    rerender({ rows: [], runs: [] });
    expect(result.current).toHaveLength(2);
  });

  it("keeps successful targets when another fails and releases the submission lock", async () => {
    const id = beginCaseLaunch(scope, targets, 1);
    await trackCaseLaunchTarget(id, 0, Promise.resolve({ runId: "accepted" }));
    await expect(
      trackCaseLaunchTarget(id, 1, Promise.reject(new Error("Offline"))),
    ).rejects.toThrow("Offline");
    finishCaseLaunch(id);
    const { result } = renderHook(() => usePendingCaseRows(scope, [], []));
    expect(result.current.map((row) => row.suiteRunId)).toEqual(["accepted"]);
    act(() => {
      beginCaseLaunch(scope, targets, 1);
    });
    expect(result.current).toHaveLength(3);
  });

  it("does not replace another launch or another effort of the same model", () => {
    const id = beginCaseLaunch(
      scope,
      [{ ...targets[0], model: "model\u0000high" }],
      1,
    );
    const { result } = renderHook(() =>
      usePendingCaseRows(
        scope,
        [realRow("a")],
        [run("a", id, "env-a"), run("b", "other", "env-a")],
      ),
    );
    expect(result.current).toHaveLength(1);
  });
});
