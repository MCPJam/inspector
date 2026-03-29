import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { EvalRunRefinementCase, EvalSuiteRun } from "../types";

const mocks = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockCreateTestCaseMutate: vi.fn(),
  mockUpdateTestCaseMutate: vi.fn(),
  mockCancelTriageMutate: vi.fn(),
  mockUseQuery: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

const navigateToEvalsRouteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/evals-router", () => ({
  navigateToEvalsRoute: (...args: unknown[]) =>
    navigateToEvalsRouteMock(...args),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: unknown) => {
    if (name === "testSuites:createTestCase") {
      return mocks.mockCreateTestCaseMutate;
    }
    if (name === "testSuites:updateTestCase") {
      return mocks.mockUpdateTestCaseMutate;
    }
    if (name === "triage:cancelTriage") {
      return mocks.mockCancelTriageMutate;
    }
    return mocks.mockMutate;
  },
  useQuery: (...args: unknown[]) => mocks.mockUseQuery(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.mockToastSuccess(...args),
    error: (...args: unknown[]) => mocks.mockToastError(...args),
  },
}));

vi.mock("@/lib/billing-entitlements", () => ({
  getBillingErrorMessage: (_error: unknown, message: string) => message,
}));

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    workspaceId: "workspace-1",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: { tests: [], environment: { servers: ["server-1"] } },
    status: "completed",
    createdAt: Date.now(),
    summary: { total: 5, passed: 4, failed: 1, passRate: 0.8 },
    ...overrides,
  };
}

function makeFailedCase(
  title: string,
  overrides: Partial<EvalRunRefinementCase> = {},
): EvalRunRefinementCase {
  return {
    sourceIterationId: `iter-${title}`,
    testCaseId: `case-${title}`,
    caseKey: `case-key-${title}`,
    title,
    query: `${title} query`,
    failureSignature: `signature-${title}`,
    failureStreak: 1,
    session: null,
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

function mockQueries({
  refinementCases = [],
  testCases = [],
}: {
  refinementCases?: EvalRunRefinementCase[];
  testCases?: Array<Record<string, unknown>>;
} = {}) {
  mocks.mockUseQuery.mockImplementation((name: string, args: unknown) => {
    if (args === "skip") {
      return undefined;
    }
    if (name === "testSuites:getRunRefinementState") {
      return { failedCases: refinementCases };
    }
    if (name === "testSuites:listTestCases") {
      return testCases;
    }
    return [];
  });
}

function getCaseRow(title: string): HTMLElement {
  const row = screen.getAllByText(title)[0]?.closest("li");
  if (!row) {
    throw new Error(`Could not find row for ${title}`);
  }
  return row;
}

async function getPanel() {
  const mod = await import("../ai-triage-panel");
  return mod.AiTriagePanel;
}

describe("AiTriagePanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockMutate.mockResolvedValue(undefined);
    mocks.mockCreateTestCaseMutate.mockResolvedValue("new-case-id");
    mocks.mockUpdateTestCaseMutate.mockResolvedValue({});
    mocks.mockCancelTriageMutate.mockResolvedValue(undefined);
    navigateToEvalsRouteMock.mockClear();
    mockQueries();
  });

  it("renders nothing when there are no failures", async () => {
    const AiTriagePanel = await getPanel();
    const run = makeRun({
      summary: { total: 5, passed: 5, failed: 0, passRate: 1 },
    });
    const { container } = render(<AiTriagePanel run={run} />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the AI summary collapsed by default", async () => {
    const AiTriagePanel = await getPanel();
    const run = makeRun({ triageStatus: "completed", triageSummary });

    render(<AiTriagePanel run={run} autoRequestTriage={false} />);

    expect(screen.getByText("AI triage summary")).toBeTruthy();
    expect(screen.queryByText(triageSummary.summary)).toBeNull();

    fireEvent.click(screen.getByText("AI triage summary"));

    expect(screen.getByText(triageSummary.summary)).toBeTruthy();
    expect(screen.getByText("Wrong tool arguments")).toBeTruthy();
    expect(screen.getByText("claude-opus-4-6")).toBeTruthy();
  });

  it("keeps triage actions inside the collapsed summary panel", async () => {
    const AiTriagePanel = await getPanel();
    const run = makeRun();

    render(<AiTriagePanel run={run} autoRequestTriage={false} />);

    expect(screen.queryByRole("button", { name: /triage failures/i })).toBeNull();

    fireEvent.click(screen.getByText("AI triage summary"));
    fireEvent.click(screen.getByRole("button", { name: /triage failures/i }));

    expect(mocks.mockMutate).toHaveBeenCalledWith({
      suiteRunId: "run-1",
      force: false,
    });
  });

  it("renders failed cases as the primary surface with one default expansion", async () => {
    const AiTriagePanel = await getPanel();

    mockQueries({
      refinementCases: [
        makeFailedCase("Broken case A", {
          session: {
            _id: "session-1",
            status: "ready",
            verificationRuns: [],
            updatedAt: Date.now(),
            baseSnapshot: {
              title: "Broken case A",
              query: "Original A",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
            candidateSnapshot: {
              title: "Broken case A rewrite",
              query: "Candidate A",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [
                { toolName: "search_projects", arguments: {} },
              ],
            },
          },
        }),
        makeFailedCase("Broken case B"),
      ],
    });

    render(<AiTriagePanel run={makeRun()} autoRequestTriage={false} />);

    expect(screen.getByText("Failed cases")).toBeTruthy();
    expect(screen.getByText("Broken case A")).toBeTruthy();
    expect(screen.getByText("Broken case B")).toBeTruthy();
    expect(screen.getByText("Candidate A")).toBeTruthy();
    expect(screen.queryByText("Broken case B query")).toBeNull();
  });

  it("keeps only one failed case expanded at a time", async () => {
    const AiTriagePanel = await getPanel();

    mockQueries({
      refinementCases: [
        makeFailedCase("Broken case A", {
          session: {
            _id: "session-1",
            status: "ready",
            verificationRuns: [],
            updatedAt: Date.now(),
            baseSnapshot: {
              title: "Broken case A",
              query: "Original A",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
            candidateSnapshot: {
              title: "Broken case A rewrite",
              query: "Candidate A",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
          },
        }),
        makeFailedCase("Broken case B", {
          session: {
            _id: "session-2",
            status: "ready",
            verificationRuns: [],
            updatedAt: Date.now(),
            baseSnapshot: {
              title: "Broken case B",
              query: "Original B",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
            candidateSnapshot: {
              title: "Broken case B rewrite",
              query: "Candidate B",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
          },
        }),
      ],
    });

    render(<AiTriagePanel run={makeRun()} autoRequestTriage={false} />);

    expect(screen.getByText("Candidate A")).toBeTruthy();
    expect(screen.queryByText("Candidate B")).toBeNull();

    fireEvent.click(
      within(getCaseRow("Broken case B")).getByRole("button", {
        name: /details/i,
      }),
    );

    expect(screen.queryByText("Candidate A")).toBeNull();
    expect(screen.getByText("Candidate B")).toBeTruthy();
  });

  it("maps refinement session states to read-only badges (no repair actions)", async () => {
    const AiTriagePanel = await getPanel();

    mockQueries({
      refinementCases: [
        makeFailedCase("Unreviewed case"),
        makeFailedCase("Generating case", {
          session: {
            _id: "session-generating",
            status: "pending_candidate",
            verificationRuns: [],
            updatedAt: Date.now(),
          },
        }),
        makeFailedCase("Ready case", {
          session: {
            _id: "session-ready",
            status: "ready",
            verificationRuns: [],
            updatedAt: Date.now(),
            candidateSnapshot: {
              title: "Ready case rewrite",
              query: "Ready query",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
          },
        }),
        makeFailedCase("Verifying case", {
          session: {
            _id: "session-verifying",
            status: "verifying",
            verificationRuns: [
              {
                label: "same-model-1",
                passed: false,
                provider: "openai",
                model: "openai/gpt-5-mini",
                query: "q",
              },
              {
                label: "same-model-2",
                passed: false,
                provider: "openai",
                model: "openai/gpt-5-mini",
                query: "q",
              },
            ],
            updatedAt: Date.now(),
          },
        }),
        makeFailedCase("Improved case", {
          session: {
            _id: "session-improved",
            status: "completed",
            outcome: "improved_test",
            verificationRuns: [],
            updatedAt: Date.now(),
          },
        }),
        makeFailedCase("Server case", {
          session: {
            _id: "session-server",
            status: "completed",
            outcome: "server_likely",
            verificationRuns: [],
            updatedAt: Date.now(),
          },
        }),
        makeFailedCase("Ambiguous case", {
          session: {
            _id: "session-ambiguous",
            status: "completed",
            outcome: "still_ambiguous",
            verificationRuns: [],
            updatedAt: Date.now(),
          },
        }),
        makeFailedCase("Retry case", {
          session: {
            _id: "session-failed",
            status: "failed",
            verificationRuns: [],
            updatedAt: Date.now(),
          },
        }),
      ],
    });

    render(<AiTriagePanel run={makeRun()} autoRequestTriage={false} />);

    expect(
      screen.getByText(/Use Trace repair in the suite header or run detail/i),
    ).toBeTruthy();

    expect(within(getCaseRow("Unreviewed case")).getByText("Unreviewed")).toBeTruthy();
    expect(
      within(getCaseRow("Unreviewed case")).queryByRole("button", {
        name: /^Refine test$/i,
      }),
    ).toBeNull();

    expect(within(getCaseRow("Generating case")).getByText("Generating")).toBeTruthy();
    expect(within(getCaseRow("Ready case")).getByText("Candidate ready")).toBeTruthy();
    expect(within(getCaseRow("Verifying case")).getByText("Verifying 2/4")).toBeTruthy();
    expect(within(getCaseRow("Improved case")).getByText("Test fixed")).toBeTruthy();
    expect(
      within(getCaseRow("Server case")).getByText("Server issue likely"),
    ).toBeTruthy();
    expect(
      within(getCaseRow("Ambiguous case")).getByText("Still ambiguous"),
    ).toBeTruthy();
    expect(within(getCaseRow("Retry case")).getByText("Needs retry")).toBeTruthy();

    expect(
      screen.queryByRole("button", { name: /^Refine test$/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Verify$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Apply fix$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Try again$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Regenerate$/i })).toBeNull();
  });

  it("keeps technical details hidden until explicitly opened", async () => {
    const AiTriagePanel = await getPanel();

    mockQueries({
      refinementCases: [
        makeFailedCase("Server case", {
          session: {
            _id: "session-server",
            status: "completed",
            outcome: "server_likely",
            attributionSummary: "Stable failure after refinement.",
            testWeaknessHypothesis: "Original prompt was vague.",
            serverHypothesis: "Server keeps enumerating resources.",
            confidenceChecklist: ["Clear failure", "Stable signature"],
            verificationRuns: [
              {
                label: "same-model-1",
                passed: false,
                provider: "openai",
                model: "openai/gpt-5-mini",
                query: "query",
                failureSignature: "failure-1",
              },
            ],
            updatedAt: Date.now(),
            candidateSnapshot: {
              title: "Server case rewrite",
              query: "Direct lookup",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [
                { toolName: "search_projects", arguments: { name: "A" } },
              ],
            },
          },
        }),
      ],
    });

    render(<AiTriagePanel run={makeRun()} autoRequestTriage={false} />);

    expect(screen.queryByText("Original prompt was vague.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.queryByText("Original prompt was vague.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /technical details/i }));

    expect(screen.getByText("Original prompt was vague.")).toBeTruthy();
    expect(screen.getByText("Server keeps enumerating resources.")).toBeTruthy();
    expect(screen.getByText("Expected tool calls (JSON)")).toBeTruthy();
  });

  it("keeps suggested tests hidden under More test ideas by default", async () => {
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

    mockQueries({
      testCases: [
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
      ],
    });

    render(<AiTriagePanel run={run} autoRequestTriage={false} />);

    expect(screen.getByText("More test ideas")).toBeTruthy();
    expect(screen.queryByText("Follow-up A")).toBeNull();

    fireEvent.click(screen.getByText("More test ideas"));

    expect(screen.getByText("Follow-up A")).toBeTruthy();
  });

  it("does not show Apply fix in expanded verdict for improved_test sessions", async () => {
    const AiTriagePanel = await getPanel();

    mockQueries({
      refinementCases: [
        makeFailedCase("Improved case", {
          session: {
            _id: "session-1",
            status: "completed",
            outcome: "improved_test",
            verificationRuns: [],
            updatedAt: Date.now(),
            baseSnapshot: {
              title: "Improved case",
              query: "Original query",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [],
            },
            candidateSnapshot: {
              title: "Improved case rewrite",
              query: "Better query",
              runs: 1,
              models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
              expectedToolCalls: [
                { toolName: "search_projects", arguments: {} },
              ],
            },
          },
        }),
      ],
    });

    render(<AiTriagePanel run={makeRun()} autoRequestTriage={false} />);

    fireEvent.click(
      within(getCaseRow("Improved case")).getByRole("button", {
        name: /^Details$/i,
      }),
    );

    expect(screen.queryByRole("button", { name: /^Apply fix$/i })).toBeNull();
    expect(screen.getByText("This looks like a better test")).toBeTruthy();
  });

  it("applies a positive suggestion to an existing negative test as isNegativeTest=false", async () => {
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

    mockQueries({
      testCases: [
        {
          _id: "c-existing",
          testSuiteId: "suite-1",
          createdBy: "u",
          title: "Existing case",
          query: "old query",
          models: [{ model: "m", provider: "openai" }],
          runs: 1,
          isNegativeTest: true,
          expectedToolCalls: [],
        },
      ],
    });

    render(<AiTriagePanel run={run} autoRequestTriage={false} />);

    fireEvent.click(screen.getByText("More test ideas"));
    fireEvent.click(
      screen.getByRole("button", { name: /apply to test…/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Apply to test$/i }));

    await waitFor(() => {
      expect(mocks.mockUpdateTestCaseMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          testCaseId: "c-existing",
          query: "New query text",
          expectedToolCalls: [{ toolName: "t", arguments: {} }],
          isNegativeTest: false,
        }),
      );
    });
  });

  it("renders nothing when the backend triage function is unavailable", async () => {
    mocks.mockMutate.mockRejectedValue(
      new Error("Could not find function triage:requestTriage"),
    );
    const AiTriagePanel = await getPanel();
    const run = makeRun();
    const { container } = render(
      <AiTriagePanel run={run} autoRequestTriage={false} />,
    );

    fireEvent.click(screen.getByText("AI triage summary"));
    fireEvent.click(screen.getByRole("button", { name: /triage failures/i }));

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});
