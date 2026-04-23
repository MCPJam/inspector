import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { usePlaygroundWorkspaceExecutions } from "../use-playground-workspace-executions";
import type { EvalCase, EvalIteration } from "../types";

const queryMock = vi.fn();

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: queryMock,
  }),
}));

describe("usePlaygroundWorkspaceExecutions", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("merges getAllTestCasesAndIterationsBySuite results for multiple suites", async () => {
    const caseA: EvalCase = {
      _id: "case-a",
      testSuiteId: "suite-a",
      createdBy: "u",
      title: "Case A",
      query: "q",
      models: [],
      runs: 0,
      expectedToolCalls: [],
    };
    const iterA: EvalIteration = {
      _id: "iter-a",
      testCaseId: "case-a",
      createdBy: "u",
      iterationNumber: 1,
      createdAt: 1,
      updatedAt: 1,
      status: "completed",
      result: "passed",
      actualToolCalls: [],
      tokensUsed: 0,
    };

    queryMock.mockImplementation(async (_name: string, args: { suiteId: string }) => {
      if (args.suiteId === "suite-a") {
        return { testCases: [caseA], iterations: [iterA] };
      }
      if (args.suiteId === "suite-b") {
        return { testCases: [], iterations: [] };
      }
      return { testCases: [], iterations: [] };
    });

    const { result } = renderHook(() =>
      usePlaygroundWorkspaceExecutions({
        enabled: true,
        suiteIds: ["suite-b", "suite-a"],
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });

    expect(result.current.cases).toEqual([caseA]);
    expect(result.current.iterations).toEqual([iterA]);
    expect(result.current.iterationToSuiteId.get("iter-a")).toBe("suite-a");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("stays idle when disabled", async () => {
    queryMock.mockResolvedValue({ testCases: [], iterations: [] });

    const { result } = renderHook(() =>
      usePlaygroundWorkspaceExecutions({
        enabled: false,
        suiteIds: ["suite-a"],
      }),
    );

    expect(result.current.status).toBe("idle");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
