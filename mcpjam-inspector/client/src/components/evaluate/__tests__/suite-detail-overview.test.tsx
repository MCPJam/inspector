import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteDetailOverview } from "../suite-detail-overview";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../../evals/types";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

function makeSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    _id: "suite-1",
    createdBy: "u1",
    name: "checkout-flow",
    description: "",
    configRevision: "1",
    environment: { servers: ["payments", "catalog"] },
    createdAt: 1,
    updatedAt: 1,
    source: "ui",
    defaultPassCriteria: { minimumPassRate: 80 },
    ...overrides,
  };
}

function makeCase(overrides: Partial<EvalCase> & { _id: string }): EvalCase {
  return {
    testSuiteId: "suite-1",
    createdBy: "u1",
    title: "Pay invoice",
    query: "Pay the open invoice",
    models: [{ model: "gpt-5-nano", provider: "openai" }],
    runs: 1,
    expectedToolCalls: [{ toolName: "checkout", arguments: {} }],
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    namedHostId: "host-1",
    ...overrides,
  };
}

function makeIteration(
  overrides: Partial<EvalIteration> & { _id: string },
): EvalIteration {
  return {
    createdBy: "u1",
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_008_000,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [{ toolName: "checkout", arguments: {} }],
    tokensUsed: 120,
    testCaseSnapshot: {
      title: "Pay invoice",
      query: "Pay",
      provider: "openai",
      model: "gpt-5-nano",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

const hostNamesById = new Map<string, string | null>([["host-1", "Claude"]]);

describe("SuiteDetailOverview", () => {
  it("renders identity counts, run history, and clickable cases", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    const onEditSuite = vi.fn();
    const onEditCases = vi.fn();
    const onRunClick = vi.fn();
    const onTestCaseClick = vi.fn();

    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[
          makeCase({ _id: "case-1" }),
          makeCase({ _id: "case-2", title: "Refund order" }),
        ]}
        runs={[
          makeRun({
            _id: "run-1",
            source: "sdk",
            result: "failed",
            summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
          }),
          makeRun({
            _id: "run-2",
            createdAt: 1_600_000_000_000,
            completedAt: 1_600_000_005_000,
            source: "github_check",
            ciMetadata: { jobId: "4188" },
          }),
        ]}
        runsLoading={false}
        allIterations={[
          makeIteration({
            _id: "i1",
            suiteRunId: "run-1",
            result: "failed",
            resultSource: "reported",
            error: "card declined",
          }),
          makeIteration({
            _id: "i2",
            suiteRunId: "run-2",
            createdAt: 1_600_000_000_000,
            startedAt: 1_600_000_000_000,
            updatedAt: 1_600_000_004_000,
          }),
        ]}
        hostNamesById={hostNamesById}
        onRerun={onRerun}
        onEditSuite={onEditSuite}
        onEditCases={onEditCases}
        onRunClick={onRunClick}
        onTestCaseClick={onTestCaseClick}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByTestId("suite-detail-identity")).toHaveTextContent(
      "checkout-flow",
    );
    expect(screen.getByTestId("suite-detail-identity")).not.toHaveTextContent(
      "2 cases",
    );

    expect(screen.getByRole("heading", { name: "Run History" })).toBeTruthy();
    expect(screen.getByLabelText("Filter by verdict")).toBeTruthy();
    expect(screen.getByLabelText("Filter by client")).toBeTruthy();
    expect(screen.getByLabelText("Filter by model")).toBeTruthy();
    expect(screen.getByTestId("suite-detail-run-aggregates")).toHaveTextContent(
      "runs",
    );
    expect(screen.getByText("card declined")).toBeTruthy();
    expect(screen.getByText("GitHub #4188")).toBeTruthy();
    expect(screen.getByText("Hold")).toBeTruthy();

    await user.click(screen.getByTestId("suite-run-row-run-1"));
    expect(onRunClick).toHaveBeenCalledWith("run-1");

    expect(screen.getByRole("heading", { name: "Test Cases" })).toBeTruthy();
    expect(screen.getByTestId("suite-test-case-row-case-1")).toHaveTextContent(
      "Pay invoice",
    );
    expect(screen.getByTestId("suite-test-case-row-case-1")).toHaveTextContent(
      "checkout",
    );
    await user.click(screen.getByTestId("suite-test-case-row-case-2"));
    expect(onTestCaseClick).toHaveBeenCalledWith("case-2");

    // "Edit" is the SUITE's (→ settings); the cases card says what it does.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEditSuite).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Add case" }));
    expect(onEditCases).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Run this suite" }));
    expect(onRerun).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "suite-1" }),
    );
  });

  it("hides run history and test cases when the suite has no cases", async () => {
    const user = userEvent.setup();
    const onEditCases = vi.fn();
    const onGenerateTestCases = vi.fn();
    const onImportCases = vi.fn();

    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={onEditCases}
        onGenerateTestCases={onGenerateTestCases}
        canGenerateTestCases
        onImportCases={onImportCases}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByTestId("suite-detail-empty-cases")).toHaveTextContent(
      "No cases yet",
    );
    expect(screen.queryByRole("heading", { name: "Run History" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Test Cases" })).toBeNull();
    expect(screen.queryByText("No runs yet. Run this suite to see history.")).toBeNull();
    expect(screen.queryByText("No test cases yet.")).toBeNull();

    await user.click(screen.getByTestId("suite-empty-action-describe"));
    expect(onEditCases).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("suite-empty-action-generate"));
    expect(onGenerateTestCases).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("suite-empty-action-import"));
    expect(onImportCases).toHaveBeenCalledTimes(1);
  });

  it("keeps run history when a suite has runs but no cases", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[]}
        runs={[makeRun({ _id: "run-1" })]}
        runsLoading={false}
        allIterations={[makeIteration({ _id: "i1", suiteRunId: "run-1" })]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByRole("heading", { name: "Run History" })).toBeTruthy();
    expect(screen.getByTestId("suite-detail-empty-cases")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Test Cases" })).toBeNull();
  });

  it("omits client and model filters when those fields are absent", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[makeRun({ _id: "run-1", namedHostId: undefined })]}
        runsLoading={false}
        allIterations={[
          makeIteration({
            _id: "i1",
            suiteRunId: "run-1",
            testCaseSnapshot: {
              title: "Pay invoice",
              query: "Pay",
              provider: "openai",
              model: "",
              expectedToolCalls: [],
            },
          }),
        ]}
        hostNamesById={new Map()}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByLabelText("Filter by verdict")).toBeTruthy();
    expect(screen.queryByLabelText("Filter by client")).toBeNull();
    expect(screen.queryByLabelText("Filter by model")).toBeNull();
  });

  it("shows a view-all footer when more runs exist than the page size", async () => {
    const user = userEvent.setup();
    const runs = Array.from({ length: 9 }, (_, index) =>
      makeRun({
        _id: `run-${index}`,
        createdAt: 1_700_000_000_000 + index,
        completedAt: 1_700_000_000_100 + index,
      }),
    );

    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={runs}
        runsLoading={false}
        allIterations={runs.map((run, index) =>
          makeIteration({
            _id: `i-${index}`,
            suiteRunId: run._id,
          }),
        )}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByText("view all 9 runs →")).toBeTruthy();
    expect(screen.queryByTestId("suite-run-row-run-0")).toBeNull();
    await user.click(screen.getByText("view all 9 runs →"));
    expect(screen.getByTestId("suite-run-row-run-0")).toBeTruthy();
  });

  it("hides run history when the suite has cases but no runs", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.queryByRole("heading", { name: "Run History" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Test Cases" })).toBeTruthy();
  });

  it("keeps Generate reachable once the suite already has cases", async () => {
    const user = userEvent.setup();
    const onGenerateTestCases = vi.fn();
    const onEditCases = vi.fn();

    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={onEditCases}
        onGenerateTestCases={onGenerateTestCases}
        canGenerateTestCases
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    // The empty hero is gone at this point — Generate has to live on the card.
    expect(screen.queryByTestId("suite-empty-action-generate")).toBeNull();

    await user.click(screen.getByTestId("suite-detail-generate-cases"));
    expect(onGenerateTestCases).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Add case" }));
    expect(onEditCases).toHaveBeenCalledTimes(1);
  });

  it("disables the card's Generate while a generation is already running", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        isGeneratingTestCases
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByTestId("suite-detail-generate-cases")).toBeDisabled();
  });

  it("hides both case-authoring controls on a read-only suite", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
        readOnlyConfig
      />,
    );

    expect(screen.queryByTestId("suite-detail-generate-cases")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add case" })).toBeNull();
  });

  it("disables Generate in the empty state until servers can be discovered", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite({ environment: { servers: [] } })}
        cases={[]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases={false}
        generateTestCasesDisabledReason="Configure suite servers before generating cases."
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByTestId("suite-empty-action-generate")).toBeDisabled();
    expect(screen.getByTestId("suite-empty-action-describe")).not.toBeDisabled();
    expect(screen.getByTestId("suite-empty-action-import")).not.toBeDisabled();
  });

  it("holds the run-history frame while runs are still loading", () => {
    // `isSuiteRunsLoading` is its own query and resolves AFTER the detail
    // spinner clears, so a suite with runs would otherwise show nothing here
    // and then pop the whole section in.
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[]}
        runsLoading
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    expect(screen.getByRole("heading", { name: "Run History" })).toBeTruthy();
    expect(screen.getByText("Loading runs\u2026")).toBeTruthy();
    expect(screen.queryByText("No runs match these filters.")).toBeNull();
  });

  it("names the active filter and releases a value that leaves the option set", async () => {
    const user = userEvent.setup();
    const twoClientHosts = new Map<string, string | null>([
      ["host-1", "Claude"],
      ["host-2", "Cursor"],
    ]);
    const bothRuns = [
      makeRun({ _id: "run-1" }),
      makeRun({ _id: "run-2", namedHostId: "host-2" }),
    ];
    const iterations = [
      makeIteration({ _id: "i1", suiteRunId: "run-1" }),
      makeIteration({ _id: "i2", suiteRunId: "run-2" }),
    ];
    const view = (runs: EvalSuiteRun[]) => (
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={runs}
        runsLoading={false}
        allIterations={iterations}
        hostNamesById={twoClientHosts}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />
    );

    const { rerender } = renderWithProviders(view(bothRuns));

    const clientFilter = screen.getByRole("combobox", {
      name: "Filter by client",
    });
    await user.click(clientFilter);
    await user.click(screen.getByRole("option", { name: "Cursor" }));

    // The trigger names the selection, not just the dimension.
    expect(clientFilter).toHaveTextContent("Client \u00b7 Cursor");
    expect(screen.queryByTestId("suite-run-row-run-1")).toBeNull();
    expect(screen.getByTestId("suite-run-row-run-2")).toBeTruthy();

    // Cursor's only run disappears (live update / rerun on another client).
    // The filter must release rather than strand the table on a value the
    // user can no longer see or clear.
    rerender(view([bothRuns[0]]));

    expect(
      screen.getByRole("combobox", { name: "Filter by client" }),
    ).toHaveTextContent("Client");
    expect(
      screen.queryByText("No runs match these filters."),
    ).toBeNull();
    expect(screen.getByTestId("suite-run-row-run-1")).toBeTruthy();
  });

});
