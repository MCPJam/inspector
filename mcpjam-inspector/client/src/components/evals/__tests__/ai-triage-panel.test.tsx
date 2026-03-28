import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const triageSummary = {
  summary: "The model failed to look up users by name.",
  failureCategories: [
    {
      category: "Wrong tool arguments",
      count: 1,
      testCaseTitles: ["Lookup user by name"],
      recommendation: "Ensure the name argument is passed correctly.",
    },
  ],
  topRecommendations: ["Fix the name argument in lookup_user tool calls."],
  modelUsed: "claude-opus-4-6",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AiTriagePanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMutate.mockResolvedValue(undefined);
  });

  async function getPanel() {
    const mod = await import("../ai-triage-panel");
    return mod.AiTriagePanel;
  }

  describe("visibility", () => {
    it("renders nothing when there are no failures (summary)", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        summary: { total: 5, passed: 5, failed: 0, passRate: 1 },
      });
      const { container } = render(<AiTriagePanel run={run} />);
      expect(container.firstChild).toBeNull();
    });

    it("renders nothing when failedCount prop is 0", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun(); // summary.failed = 1
      const { container } = render(<AiTriagePanel run={run} failedCount={0} />);
      expect(container.firstChild).toBeNull();
    });

    it("shows triage button when failedCount overrides a zero summary", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        summary: { total: 5, passed: 5, failed: 0, passRate: 1 },
      });
      render(
        <AiTriagePanel run={run} failedCount={1} autoRequestTriage={false} />,
      );
      expect(
        screen.getByRole("button", { name: /triage failures/i }),
      ).toBeTruthy();
    });

    it("shows triage button for completed run with failures and no prior triage", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun();
      render(<AiTriagePanel run={run} autoRequestTriage={false} />);
      expect(
        screen.getByRole("button", { name: /triage failures/i }),
      ).toBeTruthy();
    });

    it("renders nothing when run is still running", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ status: "running" });
      const { container } = render(<AiTriagePanel run={run} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("pending state", () => {
    it("shows analyzing spinner when triageStatus is pending", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "pending" });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText(/ai is analyzing failures/i)).toBeTruthy();
    });

    it("does not show triage button when pending", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "pending" });
      render(<AiTriagePanel run={run} />);
      expect(
        screen.queryByRole("button", { name: /triage failures/i }),
      ).toBeNull();
    });
  });

  describe("auto triage", () => {
    it("requests triage on mount when run has failures and no triage status", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun();
      render(<AiTriagePanel run={run} />);
      await waitFor(() => {
        expect(mockMutate).toHaveBeenCalledTimes(1);
      });
      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: false,
      });
    });
  });

  describe("completed state", () => {
    it("renders the triage summary text", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText(triageSummary.summary)).toBeTruthy();
    });

    it("renders failure category names and counts", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText("Wrong tool arguments")).toBeTruthy();
      expect(screen.getByText("1 failure")).toBeTruthy();
    });

    it("renders failure category test case titles as chips", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText("Lookup user by name")).toBeTruthy();
    });

    it("renders top recommendations", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      expect(
        screen.getByText(triageSummary.topRecommendations[0]),
      ).toBeTruthy();
    });

    it("renders model name in header", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText("claude-opus-4-6")).toBeTruthy();
    });

    it("shows re-triage button", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByRole("button", { name: /re-triage/i })).toBeTruthy();
    });

    it("disables re-triage button after click", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      const btn = screen.getByRole("button", { name: /re-triage/i });
      fireEvent.click(btn);
      expect(btn).toBeDisabled();
    });

    it("calls mutation with force=true on re-triage click", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "completed", triageSummary });
      render(<AiTriagePanel run={run} />);
      fireEvent.click(screen.getByRole("button", { name: /re-triage/i }));
      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: true,
      });
    });
  });

  describe("failed state", () => {
    it("shows error message when triageStatus is failed", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "failed" });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText(/ai triage failed/i)).toBeTruthy();
    });

    it("shows retry button", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "failed" });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    });

    it("calls mutation with force=true on retry", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({ triageStatus: "failed" });
      render(<AiTriagePanel run={run} />);
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: true,
      });
    });
  });

  describe("triage button", () => {
    it("calls mutation on click", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun();
      render(<AiTriagePanel run={run} autoRequestTriage={false} />);
      fireEvent.click(screen.getByRole("button", { name: /triage failures/i }));
      expect(mockMutate).toHaveBeenCalledWith({
        suiteRunId: "run-1",
        force: false,
      });
    });

    it("disables button after first click", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun();
      render(<AiTriagePanel run={run} autoRequestTriage={false} />);
      const btn = screen.getByRole("button", { name: /triage failures/i });
      fireEvent.click(btn);
      expect(btn).toBeDisabled();
    });

    it("does not call mutation again on repeated clicks", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun();
      render(<AiTriagePanel run={run} autoRequestTriage={false} />);
      const btn = screen.getByRole("button", { name: /triage failures/i });
      fireEvent.click(btn);
      fireEvent.click(btn);
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });
  });

  describe("unavailable backend", () => {
    it("renders nothing when mutation returns a not-found error", async () => {
      mockMutate.mockRejectedValue(
        new Error("Could not find function triage:requestTriage"),
      );
      const AiTriagePanel = await getPanel();
      const run = makeRun();
      const { container } = render(
        <AiTriagePanel run={run} autoRequestTriage={false} />,
      );

      fireEvent.click(screen.getByRole("button", { name: /triage failures/i }));

      // Wait for the rejected promise to settle and state to update
      await vi.waitFor(() => {
        expect(container.firstChild).toBeNull();
      });
    });
  });
});
