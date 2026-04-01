import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { RUN_INSIGHTS_SIDEBAR_LABEL } from "../run-insights-sidebar";
import { TestCaseListSidebar } from "../TestCaseListSidebar";

const baseCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "Test case",
  query: "Run a test",
  models: [{ model: "gpt-4o", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
};

const baseSuite = {
  _id: "suite-1",
  createdBy: "user-1",
  name: "Explore Suite",
  description: "Explore cases",
  configRevision: "1",
  environment: { servers: ["asana"] },
  createdAt: 1,
  updatedAt: 1,
};

describe("TestCaseListSidebar", () => {
  it("calls onRunTestCase for the selected case", async () => {
    const onRunTestCase = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId="case-1"
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        suite={baseSuite}
        onRunTestCase={onRunTestCase}
        runningTestCaseId={null}
        connectedServerNames={new Set(["asana"])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Run selected case" }));

    expect(onRunTestCase).toHaveBeenCalledTimes(1);
    expect(onRunTestCase).toHaveBeenCalledWith(baseCase);
  });

  it("disables selected-case run when no case is selected", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        suite={baseSuite}
        onRunTestCase={vi.fn()}
        runningTestCaseId={null}
        connectedServerNames={new Set(["asana"])}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Run selected case" }),
    ).toBeDisabled();
  });

  it("disables selected-case run when the suite server is disconnected", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId="case-1"
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        suite={baseSuite}
        onRunTestCase={vi.fn()}
        runningTestCaseId={null}
        connectedServerNames={new Set()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Run selected case" }),
    ).toBeDisabled();
  });

  it("calls onCopySdkEvalBrief when Copy SDK eval agent brief is clicked", async () => {
    const onCopy = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        onCopySdkEvalBrief={onCopy}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Copy SDK eval agent brief" }),
    );
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("hides Run Insights row when hideRunInsightsRow is true", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        hideRunInsightsRow
      />,
    );

    expect(
      screen.queryByRole("button", { name: RUN_INSIGHTS_SIDEBAR_LABEL }),
    ).toBeNull();
  });

  it("shows Run Insights row by default and calls onNavigateToOverview when clicked", async () => {
    const onNavigateToOverview = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        onNavigateToOverview={onNavigateToOverview}
      />,
    );

    const row = screen.getByRole("button", {
      name: RUN_INSIGHTS_SIDEBAR_LABEL,
    });
    expect(row).toBeVisible();
    await user.click(row);
    expect(onNavigateToOverview).toHaveBeenCalledTimes(1);
    expect(onNavigateToOverview).toHaveBeenCalledWith("suite-1");
  });

  it("uses insightsNavLabel for the nav row", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[baseCase]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
        insightsNavLabel="Runs"
      />,
    );

    expect(screen.getByRole("button", { name: "Runs" })).toBeVisible();
  });

  it("disables Copy SDK eval agent brief when there are no cases", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[]}
        suiteId="suite-1"
        selectedTestId={null}
        isLoading={false}
        onCreateTestCase={vi.fn()}
        onDeleteTestCase={vi.fn()}
        onDuplicateTestCase={vi.fn()}
        onCopySdkEvalBrief={vi.fn()}
        deletingTestCaseId={null}
        duplicatingTestCaseId={null}
        showingOverview
      />,
    );

    expect(
      screen.getByRole("button", { name: "Copy SDK eval agent brief" }),
    ).toBeDisabled();
  });
});
