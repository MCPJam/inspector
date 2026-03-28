import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { EvalSuiteRun } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockCreateTestCaseMutate: vi.fn(),
  mockUpdateTestCaseMutate: vi.fn(),
  mockCancelTriageMutate: vi.fn(),
  mockUseQuery: vi.fn(),
}));

const navigateToEvalsRouteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/evals-router", () => ({
  navigateToEvalsRoute: (...args: unknown[]) =>
    navigateToEvalsRouteMock(...args),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: unknown) => {
    if (name === "testSuites:createTestCase")
      return mocks.mockCreateTestCaseMutate;
    if (name === "testSuites:updateTestCase")
      return mocks.mockUpdateTestCaseMutate;
    if (name === "triage:cancelTriage") return mocks.mockCancelTriageMutate;
    return mocks.mockMutate;
  },
  useQuery: (...args: unknown[]) => mocks.mockUseQuery(...args),
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
  generatedAt: Date.now(),
  modelUsed: "claude-opus-4-6",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AiTriagePanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockMutate.mockResolvedValue(undefined);
    mocks.mockCreateTestCaseMutate.mockResolvedValue("new-case-id");
    mocks.mockUpdateTestCaseMutate.mockResolvedValue({});
    mocks.mockCancelTriageMutate.mockResolvedValue(undefined);
    navigateToEvalsRouteMock.mockClear();
    mocks.mockUseQuery.mockImplementation((_name: string, args: unknown) => {
      if (args === "skip") return undefined;
      return [];
    });
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
      expect(screen.getByText(/analyzing failures/i)).toBeTruthy();
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
        expect(mocks.mockMutate).toHaveBeenCalledTimes(1);
      });
      expect(mocks.mockMutate).toHaveBeenCalledWith({
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

    it("navigates to test edit when a failure chip matches failedTestTitleToCaseId", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          failureCategories: [
            {
              category: "Routing",
              count: 1,
              testCaseTitles: ["Lookup user by name"],
              recommendation: "Fix tools.",
            },
          ],
        },
      });
      render(
        <AiTriagePanel
          run={run}
          failedTestTitleToCaseId={{ "Lookup user by name": "case-99" }}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Lookup user by name/i }),
      );
      expect(navigateToEvalsRouteMock).toHaveBeenCalledWith({
        type: "test-edit",
        suiteId: "suite-1",
        testId: "case-99",
      });
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
      expect(mocks.mockMutate).toHaveBeenCalledWith({
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
      expect(screen.getByText(/couldn.?t complete analysis/i)).toBeTruthy();
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
      expect(mocks.mockMutate).toHaveBeenCalledWith({
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
      expect(mocks.mockMutate).toHaveBeenCalledWith({
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
      expect(mocks.mockMutate).toHaveBeenCalledTimes(1);
    });
  });

  describe("suggested follow-ups", () => {
    it("renders suggested cases for UI runs", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          suggestedTestCases: [
            {
              title: "Follow-up A",
              query: "Do the thing",
              expectedToolCalls: [
                { toolName: "t", arguments: { x: 1 } },
              ],
              rationale: "Covers edge case",
            },
          ],
        },
      });
      mocks.mockUseQuery.mockImplementation((_name, args) => {
        if (args === "skip") return undefined;
        return [
          {
            _id: "c1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Existing",
            query: "",
            models: [
              { model: "model-a", provider: "openai" },
              { model: "model-b", provider: "anthropic" },
            ],
            runs: 1,
            expectedToolCalls: [],
          },
        ];
      });
      render(<AiTriagePanel run={run} />);
      expect(screen.getByText("Suggested tests")).toBeTruthy();
      expect(screen.getByText("Follow-up A")).toBeTruthy();
    });

    it("hides suggested cases for SDK runs", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        source: "sdk",
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          suggestedTestCases: [
            {
              title: "Follow-up A",
              query: "Do the thing",
              expectedToolCalls: [],
            },
          ],
        },
      });
      render(<AiTriagePanel run={run} />);
      expect(screen.queryByText("Suggested tests")).toBeNull();
    });

    it("Add to suite sends createTestCase with suite-wide models", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          suggestedTestCases: [
            {
              title: "Follow-up A",
              query: "Do the thing",
              expectedToolCalls: [{ toolName: "t", arguments: {} }],
              rationale: "r",
            },
          ],
        },
      });
      mocks.mockUseQuery.mockImplementation((_name, args) => {
        if (args === "skip") return undefined;
        return [
          {
            _id: "c1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Existing",
            query: "",
            models: [
              { model: "model-a", provider: "openai" },
              { model: "model-b", provider: "anthropic" },
            ],
            runs: 1,
            expectedToolCalls: [],
          },
        ];
      });
      render(<AiTriagePanel run={run} />);
      fireEvent.click(screen.getByRole("button", { name: /add to suite/i }));
      await waitFor(() => {
        expect(mocks.mockCreateTestCaseMutate).toHaveBeenCalled();
      });
      expect(mocks.mockCreateTestCaseMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          suiteId: "suite-1",
          title: "Follow-up A",
          query: "Do the thing",
          runs: 1,
          models: [
            { model: "model-a", provider: "openai" },
            { model: "model-b", provider: "anthropic" },
          ],
          expectedToolCalls: [{ toolName: "t", arguments: {} }],
        }),
      );
    });

    it("removes the suggestion row after a successful Add to suite", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          suggestedTestCases: [
            {
              title: "Follow-up A",
              query: "Do the thing",
              expectedToolCalls: [],
            },
          ],
        },
      });
      mocks.mockUseQuery.mockImplementation((_name, args) => {
        if (args === "skip") return undefined;
        return [
          {
            _id: "c1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Existing",
            query: "",
            models: [{ model: "m", provider: "openai" }],
            runs: 1,
            expectedToolCalls: [],
          },
        ];
      });
      render(<AiTriagePanel run={run} />);
      const addBtn = screen.getByRole("button", { name: /add to suite/i });
      fireEvent.click(addBtn);
      await waitFor(() => {
        expect(mocks.mockCreateTestCaseMutate).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.queryByText("Follow-up A")).toBeNull();
      });
      expect(screen.queryByRole("button", { name: /add to suite/i })).toBeNull();
    });

    it("Apply to test opens dialog, calls updateTestCase, and removes the row", async () => {
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          suggestedTestCases: [
            {
              title: "Follow-up A",
              query: "New query text",
              expectedToolCalls: [{ toolName: "t", arguments: {} }],
            },
          ],
        },
      });
      mocks.mockUseQuery.mockImplementation((_name, args) => {
        if (args === "skip") return undefined;
        return [
          {
            _id: "c-existing",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Existing case",
            query: "old query",
            models: [{ model: "m", provider: "openai" }],
            runs: 1,
            expectedToolCalls: [],
          },
        ];
      });
      render(<AiTriagePanel run={run} />);
      fireEvent.click(
        screen.getByRole("button", { name: /apply to test…/i }),
      );
      expect(
        await screen.findByText(/Apply suggestion to a test/i),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^Apply to test$/i }));
      await waitFor(() => {
        expect(mocks.mockUpdateTestCaseMutate).toHaveBeenCalledWith(
          expect.objectContaining({
            testCaseId: "c-existing",
            query: "New query text",
            expectedToolCalls: [{ toolName: "t", arguments: {} }],
          }),
        );
      });
      await waitFor(() => {
        expect(
          screen.queryByText(/Apply suggestion to a test/i),
        ).toBeNull();
      });
      await waitFor(() => {
        expect(screen.queryByText("Follow-up A")).toBeNull();
      });
    });

    it("shows error feedback and leaves Add to suite enabled when create fails", async () => {
      mocks.mockCreateTestCaseMutate.mockRejectedValueOnce(new Error("nope"));
      const AiTriagePanel = await getPanel();
      const run = makeRun({
        triageStatus: "completed",
        triageSummary: {
          ...triageSummary,
          suggestedTestCases: [
            {
              title: "Follow-up A",
              query: "Do the thing",
              expectedToolCalls: [],
            },
          ],
        },
      });
      mocks.mockUseQuery.mockImplementation((_name, args) => {
        if (args === "skip") return undefined;
        return [
          {
            _id: "c1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Existing",
            query: "",
            models: [{ model: "m", provider: "openai" }],
            runs: 1,
            expectedToolCalls: [],
          },
        ];
      });
      render(<AiTriagePanel run={run} />);
      const addBtn = screen.getByRole("button", { name: /add to suite/i });
      fireEvent.click(addBtn);
      await waitFor(() => {
        expect(screen.getByText(/could not add test case/i)).toBeTruthy();
      });
      expect(addBtn).not.toBeDisabled();
    });
  });

  describe("unavailable backend", () => {
    it("renders nothing when mutation returns a not-found error", async () => {
      mocks.mockMutate.mockRejectedValue(
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
