import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { EvalSuiteRun } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => mockMutate,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: Date.now(),
    summary: { total: 5, passed: 4, failed: 1, passRate: 0.8 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAiTriage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMutate.mockResolvedValue(undefined);
  });

  // Lazy-import the hook inside each test so the mock is in place
  async function getHook() {
    const mod = await import("../use-ai-triage");
    return mod.useAiTriage;
  }

  describe("canTriage", () => {
    it("is true for a completed run with failures", async () => {
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));
      expect(result.current.canTriage).toBe(true);
    });

    it("is false when run is null", async () => {
      const useAiTriage = await getHook();
      const { result } = renderHook(() => useAiTriage(null));
      expect(result.current.canTriage).toBe(false);
    });

    it("is false when run is still running", async () => {
      const useAiTriage = await getHook();
      const run = makeRun({ status: "running" });
      const { result } = renderHook(() => useAiTriage(run));
      expect(result.current.canTriage).toBe(false);
    });

    it("is false when summary has 0 failures", async () => {
      const useAiTriage = await getHook();
      const run = makeRun({
        summary: { total: 5, passed: 5, failed: 0, passRate: 1 },
      });
      const { result } = renderHook(() => useAiTriage(run));
      expect(result.current.canTriage).toBe(false);
    });

    it("is false when triage is already pending", async () => {
      const useAiTriage = await getHook();
      const run = makeRun({ triageStatus: "pending" });
      const { result } = renderHook(() => useAiTriage(run));
      expect(result.current.canTriage).toBe(false);
    });

    it("uses failedCount prop over run.summary.failed", async () => {
      const useAiTriage = await getHook();
      // summary says 0 failures, but failedCount override says 1
      const run = makeRun({
        summary: { total: 5, passed: 5, failed: 0, passRate: 1 },
      });
      const { result } = renderHook(() => useAiTriage(run, 1));
      expect(result.current.canTriage).toBe(true);
    });

    it("is false when failedCount is 0 even if summary.failed > 0", async () => {
      const useAiTriage = await getHook();
      const run = makeRun(); // summary.failed = 1
      const { result } = renderHook(() => useAiTriage(run, 0));
      expect(result.current.canTriage).toBe(false);
    });
  });

  describe("requestTriage", () => {
    it("calls the mutation with suiteRunId and force=false for untriaged run", async () => {
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: false,
      });
    });

    it("calls mutation with force=true when re-triaging a completed triage", async () => {
      const useAiTriage = await getHook();
      const run = makeRun({ triageStatus: "completed" });
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: true,
      });
    });

    it("calls mutation with force=true when retrying a failed triage", async () => {
      const useAiTriage = await getHook();
      const run = makeRun({ triageStatus: "failed" });
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: true,
      });
    });

    it("sets requested=true after first call", async () => {
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));

      expect(result.current.requested).toBe(false);

      await act(async () => {
        result.current.requestTriage();
      });

      expect(result.current.requested).toBe(true);
    });

    it("does not call mutation a second time if already requested", async () => {
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });
      await act(async () => {
        result.current.requestTriage();
      });
      await act(async () => {
        result.current.requestTriage();
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    it("does nothing when run is null", async () => {
      const useAiTriage = await getHook();
      const { result } = renderHook(() => useAiTriage(null));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("sets unavailable when mutation reports function not found", async () => {
      mockMutate.mockRejectedValue(
        new Error("Could not find function triage:requestTriage"),
      );
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(result.current.unavailable).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it("sets unavailable on 'Server Error' message", async () => {
      mockMutate.mockRejectedValue(new Error("Server Error: internal"));
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(result.current.unavailable).toBe(true);
    });

    it("sets error message for non-availability errors", async () => {
      mockMutate.mockRejectedValue(new Error("Rate limit exceeded"));
      const useAiTriage = await getHook();
      const run = makeRun();
      const { result } = renderHook(() => useAiTriage(run));

      await act(async () => {
        result.current.requestTriage();
      });

      expect(result.current.error).toBe("Rate limit exceeded");
      expect(result.current.unavailable).toBe(false);
    });
  });
});
