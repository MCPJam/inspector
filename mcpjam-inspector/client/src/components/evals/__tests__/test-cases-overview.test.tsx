import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, waitFor, within } from "@/test";
import { TestCasesOverview } from "../test-cases-overview";

const useConvexMock = vi.hoisted(() => vi.fn());
const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useConvex: useConvexMock,
  useQuery: useQueryMock,
}));

describe("TestCasesOverview", () => {
  const suite = {
    _id: "suite-1",
    name: "Suite 1",
    source: "ui" as const,
  };

  const baseCase = {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "user-1",
    title: "Create a simple flowchart diagram",
    query: "Draw a basic flowchart",
    models: [{ model: "gpt-5-nano", provider: "openai" }],
    runs: 1,
    expectedToolCalls: [],
    lastMessageRun: null,
  };

  const savedIteration = {
    _id: "iter-1",
    testCaseId: "case-1",
    createdBy: "user-1",
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now() - 1_000,
    iterationNumber: 1,
    status: "completed" as const,
    result: "passed" as const,
    resultSource: "reported" as const,
    actualToolCalls: [],
    tokensUsed: 42,
    testCaseSnapshot: {
      title: "Create a simple flowchart diagram",
      query: "Draw a basic flowchart",
      provider: "openai",
      model: "gpt-5-nano",
      expectedToolCalls: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates saved quick runs from fresh case metadata and iteration queries", async () => {
    const convexQueryMock = vi.fn(async (name: string) => {
      if (name === "testSuites:listTestIterations") {
        return [savedIteration];
      }
      if (name === "testSuites:getTestIteration") {
        return savedIteration;
      }
      return null;
    });

    useConvexMock.mockReturnValue({ query: convexQueryMock });
    useQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:listTestCases") {
        return [
          {
            ...baseCase,
            lastMessageRun: savedIteration._id,
          },
        ];
      }
      return undefined;
    });

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    const row = await screen.findByRole("button", {
      name: /Create a simple flowchart diagram/i,
    });

    await waitFor(() => {
      expect(within(row).getAllByText("Passed")).toHaveLength(2);
    });

    expect(within(row).getByText("1")).toBeInTheDocument();
    expect(convexQueryMock).toHaveBeenCalledWith(
      "testSuites:listTestIterations",
      { testCaseId: "case-1" },
    );
  });
});
