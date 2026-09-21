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

  it("shows each case's import claim, in the same words the overview uses", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[
          {
            ...baseCase,
            import: { status: "exact", note: "1:1 with the upstream form." },
          },
          {
            ...baseCase,
            _id: "case-2",
            title: "Approximated case",
            import: { status: "approximated", note: "Mapped to negative." },
          },
          { ...baseCase, _id: "case-3", title: "Native case" },
        ]}
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
        connectedServerNames={new Set(["asana"])}
      />,
    );

    // The same copy as the overview, because a converted case's
    // trustworthiness is not something a reader should have to reconcile
    // across two surfaces.
    expect(screen.getByText("claimed exact")).toBeInTheDocument();
    expect(screen.getByText("approximated")).toBeInTheDocument();
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
    // Three cases, two claims: the native one gets no badge.
    expect(screen.getAllByTestId(/^import-claim-/)).toHaveLength(2);
  });

  it("renders no badge for a cleared, absent, or unrecognized claim", () => {
    renderWithProviders(
      <TestCaseListSidebar
        testCases={[
          // A PATCH that cleared the claim stores `null`; an absent field means
          // the case was authored here. Both mean "no badge", and a component
          // that guarded only `undefined` would crash the sidebar on the first
          // cleared row.
          { ...baseCase, import: null },
          { ...baseCase, _id: "case-2", title: "Native case" },
          // A status from a newer writer is shown as nothing rather than as a
          // guessed label — a made-up badge would read as an assertion MCPJam
          // never made.
          {
            ...baseCase,
            _id: "case-3",
            title: "Future case",
            import: { status: "probably-fine" },
          },
        ]}
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
        connectedServerNames={new Set(["asana"])}
      />,
    );

    expect(screen.queryAllByTestId(/^import-claim-/)).toHaveLength(0);
    // …and the rows themselves still rendered, so this is "no badge", not
    // "the list blew up".
    expect(screen.getByText("Future case")).toBeInTheDocument();
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

  it("hides the selected-case run shortcut when hideRunAction is true", () => {
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
        connectedServerNames={new Set(["asana"])}
        hideRunAction
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Run selected case" }),
    ).toBeNull();
  });

  it("keeps selected-case run enabled when the suite server is disconnected", () => {
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
    ).toBeEnabled();
  });

  it("still lists cases when the suite server is disconnected (noServerSelected false)", () => {
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
        noServerSelected={false}
        suite={baseSuite}
        onRunTestCase={vi.fn()}
        runningTestCaseId={null}
        connectedServerNames={new Set()}
      />,
    );

    expect(
      screen.queryByText("Select a server to view cases."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Test case")).toBeVisible();
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
