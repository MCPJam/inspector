import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalSuite } from "@/components/evals/types";
import { testRunRouteFor, useCaseRun } from "../use-case-run";

const handleRerun = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const quota = {
  value: undefined as
    | undefined
    | { used: number; allowed: number; resetsAt: number; windowKind: "day" },
};

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/use-is-direct-guest", () => ({
  useIsDirectGuest: () => false,
}));
vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({
    organizationId: null,
    connectedServerNames: new Set<string>(),
    availableModels: [],
  }),
}));
vi.mock("@/hooks/use-eval-iteration-quota", () => ({
  useEvalIterationQuota: () => ({ quota: quota.value }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectServers: () => ({ servers: [] }),
}));
vi.mock("@/components/evals/use-eval-mutations", () => ({
  useEvalMutations: () => ({}),
}));
vi.mock("@/components/evals/use-eval-handlers", () => ({
  useEvalHandlers: () => ({ handleRerun, rerunningSuiteId: null }),
}));

const suite = { _id: "suite-1", name: "Excalidraw" } as EvalSuite;

describe("useCaseRun", () => {
  beforeEach(() => {
    handleRerun.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    quota.value = undefined;
  });

  it("runs only this case and turns the launch toast into a link to the test run (O4)", async () => {
    handleRerun.mockResolvedValue({
      status: "started",
      runIds: ["run-9"],
      failedCount: 0,
      toastId: "toast-1",
    });
    const onOpenTestRun = vi.fn();
    const { result } = renderHook(() =>
      useCaseRun({
        suite,
        caseId: "case-1",
        projectId: "project-1",
        onOpenTestRun,
      }),
    );
    await act(() => result.current.run({ skipJudge: true }));
    expect(handleRerun).toHaveBeenCalledWith(suite, {
      caseIds: ["case-1"],
      skipJudge: true,
    });
    expect(toastSuccess).toHaveBeenCalledWith("Test run started.", {
      id: "toast-1",
      action: { label: "Open test run", onClick: expect.any(Function) },
    });
    toastSuccess.mock.lastCall?.[1].action.onClick();
    expect(onOpenTestRun).toHaveBeenCalledWith({
      type: "test-run",
      suiteId: "suite-1",
      runId: "run-9",
      caseId: "case-1",
    });
  });

  it("does not launch when the iteration quota is spent", async () => {
    quota.value = { used: 10, allowed: 10, resetsAt: 0, windowKind: "day" };
    const { result } = renderHook(() =>
      useCaseRun({
        suite,
        caseId: "case-1",
        projectId: null,
        onOpenTestRun: vi.fn(),
      }),
    );
    await act(() => result.current.run());
    expect(handleRerun).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });
});

describe("testRunRouteFor", () => {
  it("names the first run a launch created, or nothing", () => {
    expect(testRunRouteFor("s", "c", [])).toBeNull();
    expect(testRunRouteFor("s", "c", ["r1", "r2"])).toEqual({
      type: "test-run",
      suiteId: "s",
      runId: "r1",
      caseId: "c",
    });
  });
});
