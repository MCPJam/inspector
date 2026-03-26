import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { TestCaseListSidebar } from "../TestCaseListSidebar";

describe("TestCaseListSidebar", () => {
  it("enables suite rerun when live servers are missing but replay fallback exists", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[
          {
            _id: "case-1",
            testSuiteId: "suite-1",
            createdBy: "user-1",
            title: "Test case",
            query: "Run a test",
            models: [{ model: "gpt-4o", provider: "openai" }],
            runs: 1,
            expectedToolCalls: [],
          },
        ]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        suite={{
          _id: "suite-1",
          createdBy: "user-1",
          name: "Replayable Suite",
          description: "Uses replay",
          configRevision: "1",
          environment: { servers: ["asana"] },
          createdAt: 1,
          updatedAt: 1,
        }}
        latestRun={{
          _id: "run-1",
          suiteId: "suite-1",
          createdBy: "user-1",
          runNumber: 1,
          configRevision: "1",
          configSnapshot: {
            tests: [],
            environment: { servers: ["asana"] },
          },
          status: "completed",
          hasServerReplayConfig: true,
          createdAt: 1,
        }}
        onRerun={vi.fn()}
        rerunningSuiteId={null}
        connectedServerNames={new Set()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Run suite" }),
    ).not.toBeDisabled();
  });
});
