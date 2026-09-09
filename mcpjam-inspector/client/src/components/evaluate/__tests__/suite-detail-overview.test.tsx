import { within } from "@testing-library/react";
import {
  SuiteRunReviewContent,
  type SuiteRunReviewProps,
} from "../suite-run-review";
import {
  useEvalGeneration,
  evalSuiteKey,
  registerEvalSuite,
} from "@/lib/mcpjam-agent/eval-workspace";
import { openEvalChat } from "@/lib/mcpjam-agent/eval-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteDetailOverview } from "../suite-detail-overview";
import { formatRunHistoryDate } from "../suite-detail-model";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../../evals/types";

vi.mock("../suite-run-matrix", () => ({
  ConfiguredSuiteRunReview: (props: SuiteRunReviewProps) => (
    <SuiteRunReviewContent {...props} />
  ),
}));

vi.mock("@/lib/mcpjam-agent/eval-scope", async (original) => ({
  ...(await original<object>()),
  openEvalChat: vi.fn(() => "eval-generation-test"),
}));

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
  it("consolidates pairings into one run and filters complete runs and their trends", async () => {
    const user = userEvent.setup();
    const onRunClick = vi.fn();
    const runs = [
      makeRun({
        _id: "one",
        runNumber: 1,
        runGroupId: "together",
        namedHostId: "host-1",
        createdAt: 1000,
      }),
      makeRun({
        _id: "two",
        runNumber: 2,
        runGroupId: "together",
        namedHostId: "host-2",
        createdAt: 1001,
      }),
      makeRun({
        _id: "solo",
        runNumber: 3,
        namedHostId: "host-1",
        createdAt: 2000,
      }),
    ];
    const iterations = [
      makeIteration({
        _id: "pass",
        suiteRunId: "one",
        resultSource: "reported",
      }),
      ...[1, 2, 3].map((id) =>
        makeIteration({
          _id: `fail-${id}`,
          suiteRunId: "two",
          result: "failed",
          resultSource: "reported",
        }),
      ),
      makeIteration({
        _id: "solo-pass",
        suiteRunId: "solo",
        resultSource: "reported",
      }),
    ];
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[]}
        runs={runs}
        runsLoading={false}
        allIterations={iterations}
        hostNamesById={
          new Map([
            ["host-1", "Claude"],
            ["host-2", "Cursor"],
          ])
        }
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onRunClick={onRunClick}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );
    const table = within(
      screen.getByRole("table", { name: "Suite run history" }),
    );
    const headers = table
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers.slice(0, 2)).toEqual(["Date", "Run"]);
    expect(table.getAllByRole("button", { name: /^#/ })).toHaveLength(2);
    expect(screen.queryByTestId("suite-run-row-two")).toBeNull();
    const row = within(screen.getByTestId("suite-run-row-one"));
    const cells = screen
      .getByTestId("suite-run-row-one")
      .querySelectorAll("td");
    expect(cells[0]).toHaveTextContent(formatRunHistoryDate(1000));
    expect(cells[0]).not.toHaveTextContent("#");
    expect(cells[1]).toHaveTextContent("#1");
    expect(cells[1]).not.toHaveTextContent(formatRunHistoryDate(1000));
    expect(row.getByText("25%")).toBeVisible();
    expect(row.getByText("1/4 passed")).toBeVisible();
    expect(row.getByText(/Claude/)).toBeVisible();
    expect(
      row.queryByRole("button", { name: /Client model mapping/ }),
    ).toBeNull();
    expect(row.queryByText(/client : model pairings/i)).toBeNull();
    expect(screen.getByTestId("suite-run-history-snapshot")).toBeVisible();
    expect(screen.queryByText(/trends across/)).toBeNull();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by client" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Cursor", exact: true }),
    );
    expect(screen.queryByTestId("suite-run-row-solo")).toBeNull();
    expect(row.getByText("1/4 passed")).toBeVisible();
    expect(screen.getByTestId("suite-run-history-snapshot")).toHaveTextContent(
      "1/4 passed",
    );
    await user.click(table.getByRole("button", { name: "#1", exact: true }));
    expect(onRunClick).toHaveBeenCalledWith("one");
  });

  it("renders identity counts, run history, and clickable cases", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    const onEditSuite = vi.fn();
    const onEditCases = vi.fn();
    const onRunClick = vi.fn();
    const onTestCaseClick = vi.fn();

    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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

    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.queryByLabelText("Filter by verdict")).toBeNull();
    expect(screen.getByLabelText("Filter by client")).toBeTruthy();
    expect(screen.getByLabelText("Filter by model")).toBeTruthy();
    expect(screen.getByTestId("suite-run-history-snapshot")).toBeVisible();
    expect(screen.getByTestId("suite-run-history-snapshot")).toHaveTextContent(
      "0/1 passed",
    );
    expect(screen.queryByTestId("suite-metric-strip")).toBeNull();
    expect(screen.queryByText("card declined")).toBeNull();
    expect(screen.queryByText("Top failure signature")).toBeNull();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getAllByText("Finished").length).toBeGreaterThan(0);

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

    await user.click(screen.getByRole("button", { name: "Setup Run" }));
    expect(onRerun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(onRerun).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "suite-1" }),
      { iterationOverride: 5 },
    );
  });

  it("hides run history and test cases when the suite has no cases", async () => {
    const user = userEvent.setup();
    const onEditCases = vi.fn();
    const onGenerateTestCases = vi.fn();
    const onImportCases = vi.fn();

    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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
    expect(screen.queryByRole("heading", { name: "Runs" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Test Cases" })).toBeNull();
    // A suite with no cases cannot have run, so it gets the hero alone — not
    // an empty run history stacked on top of an empty case list.
    expect(screen.queryByTestId("suite-run-history-empty")).toBeNull();
    expect(screen.queryByText("No test cases yet.")).toBeNull();

    await user.click(screen.getByTestId("suite-empty-action-describe"));
    expect(onEditCases).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("suite-empty-action-import"));
    expect(onImportCases).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("suite-empty-action-generate"));
    expect(openEvalChat).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByTestId("suite-case-generation-workspace")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate cases" }));
    expect(screen.getByTestId("suite-case-generation-workspace")).toBeVisible();
    expect(onGenerateTestCases).not.toHaveBeenCalled();
  });

  it("starts generation directly without opening a chat", async () => {
    const user = userEvent.setup();
    const onGenerateTestCases = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn(() => new Promise<void>(() => {}));
    const unregister = registerEvalSuite(
      {
        projectId: "project-1",
        suiteId: "suite-1",
        suiteName: "Checkout reliability",
      },
      { read: () => ({}), generate, save: vi.fn() },
    );

    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
        suite={makeSuite({ name: "Checkout reliability" })}
        cases={[]}
        runs={[]}
        runsLoading={false}
        allIterations={[]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onEditCases={vi.fn()}
        onGenerateTestCases={onGenerateTestCases}
        canGenerateTestCases
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );

    await user.click(screen.getByTestId("suite-empty-action-generate"));
    expect(generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Generate cases" }));

    expect(
      screen.getByTestId("suite-case-generation-workspace"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("generating-case-skeleton")).toHaveLength(5);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    unregister();
    expect(onGenerateTestCases).not.toHaveBeenCalled();
  });

  it("keeps run history when a suite has runs but no cases", () => {
    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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

    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.getByTestId("suite-detail-empty-cases")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Test Cases" })).toBeNull();
  });

  it("omits client and model filters when those fields are absent", () => {
    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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

    expect(screen.queryByLabelText("Filter by verdict")).toBeNull();
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
        projectId="project-1"
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

  it("hides run history until the suite has actual runs", () => {
    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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

    expect(screen.queryByRole("heading", { name: "Runs" })).toBeNull();
    expect(screen.queryByTestId("suite-detail-run-history")).toBeNull();
    expect(screen.queryByTestId("suite-run-history-empty")).toBeNull();
    expect(screen.getByRole("heading", { name: "Test Cases" })).toBeTruthy();
  });

  it("keeps Generate reachable once the suite already has cases", async () => {
    const user = userEvent.setup();
    const onGenerateTestCases = vi.fn();
    const onEditCases = vi.fn();

    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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
    expect(openEvalChat).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByTestId("suite-case-generation-workspace")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate cases" }));
    expect(screen.getByTestId("suite-case-generation-workspace")).toBeVisible();
    expect(onGenerateTestCases).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Back to suite" }));
    expect(screen.queryByTestId("suite-case-generation-workspace")).toBeNull();
    expect(screen.getByTestId("suite-detail-overview")).toBeVisible();
  });

  it("disables the card's Generate while a generation is already running", () => {
    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
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
        projectId="project-1"
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
        projectId="project-1"
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
    expect(
      screen.getByTestId("suite-empty-action-describe"),
    ).not.toBeDisabled();
    expect(screen.getByTestId("suite-empty-action-import")).toBeDisabled();
  });

  it("holds the run-history frame while runs are still loading", () => {
    // `isSuiteRunsLoading` is its own query and resolves AFTER the detail
    // spinner clears, so a suite with runs would otherwise show nothing here
    // and then pop the whole section in.
    //
    // Cased on a suite with NO cases so `runsLoading` is the only term keeping
    // the frame up: with cases the card renders either way, and this assertion
    // would pass without testing anything.
    renderWithProviders(
      <SuiteDetailOverview
        projectId="project-1"
        suite={makeSuite()}
        cases={[]}
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

    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
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
        projectId="project-1"
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
    expect(clientFilter).toHaveTextContent("Cursor");
    expect(screen.queryByTestId("suite-run-row-run-1")).toBeNull();
    expect(screen.getByTestId("suite-run-row-run-2")).toBeTruthy();

    // Cursor's only run disappears (live update / rerun on another client).
    // The filter must release rather than strand the table on a value the
    // user can no longer see or clear.
    rerender(view([bothRuns[0]]));

    expect(
      screen.getByRole("combobox", { name: "Filter by client" }),
    ).toHaveTextContent("Client");
    expect(screen.queryByText("No runs match these filters.")).toBeNull();
    expect(screen.getByTestId("suite-run-row-run-1")).toBeTruthy();
  });
});

beforeEach(() => useEvalGeneration.setState({ suites: {} }));
it("shows generated drafts and explains why they cannot run yet", async () => {
  useEvalGeneration.setState({
    suites: {
      [evalSuiteKey({ projectId: "project-1", suiteId: "suite-1" })]: {
        status: "ready",
        drafts: [
          {
            id: "draft-1",
            revision: "r1",
            input: {
              suiteId: "suite-1",
              title: "Generated flowchart case",
              steps: [],
            } as any,
          },
        ],
      },
    },
  });
  renderWithProviders(
    <SuiteDetailOverview
      projectId="project-1"
      suite={makeSuite()}
      cases={[]}
      runs={[]}
      runsLoading={false}
      allIterations={[]}
      hostNamesById={hostNamesById}
      onRerun={vi.fn()}
      onEditSuite={vi.fn()}
      onEditCases={vi.fn()}
      onGenerateTestCases={vi.fn()}
      canGenerateTestCases
      onImportCases={vi.fn()}
      onRunClick={vi.fn()}
      onTestCaseClick={vi.fn()}
      rerunningSuiteId={null}
    />,
  );
  expect(screen.queryByText("Generated flowchart case")).toBeNull();
  expect(screen.getByRole("button", { name: "Review Draft Cases" })).toHaveAttribute("aria-expanded", "false");
  await userEvent.setup().click(screen.getByRole("button", { name: "Review Draft Cases" }));
  expect(screen.getByText("Generated flowchart case")).toBeVisible();
  expect(screen.queryByText("No cases yet")).toBeNull();
  expect(screen.queryByTestId("suite-detail-test-cases")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Describe another case" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Generate", exact: true }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Import cases" })).toBeVisible();
  await userEvent
    .setup()
    .hover(
      screen.getByRole("button", { name: "Setup Run", exact: true })
        .parentElement!,
    );
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "1 generated draft is waiting to be added",
  );
});

/**
 * A suite whose configuration lives in a repository.
 *
 * The lock's shape: the app stops OFFERING edits it knows the backend will
 * refuse, says why, and points at the one way forward. Running it is untouched
 * — running a CI-owned suite from the app is the point, and a lock that took
 * Run away would make the suite look broken rather than managed.
 */
describe("SuiteDetailOverview — a CI-managed suite", () => {
  function renderLocked(overrides: Partial<EvalSuite> = {}) {
    const onEditSuite = vi.fn();
    const onDuplicateSuite = vi.fn();
    const onRerun = vi.fn();
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite(overrides)}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[makeRun({ _id: "run-1" })]}
        runsLoading={false}
        allIterations={[makeIteration({ _id: "i1", suiteRunId: "run-1" })]}
        hostNamesById={hostNamesById}
        onRerun={onRerun}
        onEditSuite={onEditSuite}
        onDuplicateSuite={onDuplicateSuite}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
        configLocked
      />,
    );
    return { onEditSuite, onDuplicateSuite, onRerun };
  }

  it("replaces Edit with the reason and a way forward", () => {
    renderLocked({ declaredSuiteId: "s_from_file" });

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // The reason and the remedy TOGETHER. A disabled Edit with a tooltip would
    // make the way out discoverable only by hovering the thing that does not
    // work.
    expect(screen.getByTestId("suite-detail-ci-owned")).toHaveTextContent(
      /Managed by CI/i,
    );
    expect(screen.getByTestId("suite-detail-duplicate-to-edit")).toBeTruthy();
  });

  it("takes an editable copy when Duplicate is used", async () => {
    const user = userEvent.setup();
    const { onDuplicateSuite } = renderLocked({
      declaredSuiteId: "s_from_file",
    });

    await user.click(screen.getByTestId("suite-detail-duplicate-to-edit"));
    // `duplicateTestSuite` stamps the copy `source: 'ui'` and drops the
    // declared id, so the copy really is editable.
    expect(onDuplicateSuite).toHaveBeenCalledTimes(1);
  });

  it("keeps the case list readable but offers no case authoring", () => {
    renderLocked({ declaredSuiteId: "s_from_file" });

    // The cases are the point of looking at the suite; only writing them is
    // refused.
    expect(screen.getByTestId("suite-detail-test-cases")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add case/i })).toBeNull();
  });

  it("locks an SDK-created suite the same way", () => {
    renderLocked({ source: "sdk" });
    expect(screen.getByTestId("suite-detail-ci-owned")).toBeTruthy();
  });

  it("leaves an app-authored suite alone", () => {
    renderWithProviders(
      <SuiteDetailOverview
        suite={makeSuite()}
        cases={[makeCase({ _id: "case-1" })]}
        runs={[makeRun({ _id: "run-1" })]}
        runsLoading={false}
        allIterations={[makeIteration({ _id: "i1", suiteRunId: "run-1" })]}
        hostNamesById={hostNamesById}
        onRerun={vi.fn()}
        onEditSuite={vi.fn()}
        onDuplicateSuite={vi.fn()}
        onRunClick={vi.fn()}
        onTestCaseClick={vi.fn()}
        rerunningSuiteId={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByTestId("suite-detail-ci-owned")).toBeNull();
    // …and the escape hatch is not offered where there is nothing to escape.
    expect(screen.queryByTestId("suite-detail-duplicate-to-edit")).toBeNull();
  });
});

it("offers Markdown import in populated editable suites", async () => {
  const onImportCases = vi.fn();
  renderWithProviders(
    <SuiteDetailOverview
      suite={makeSuite()}
      cases={[makeCase({ _id: "case-import" })]}
      runs={[]}
      runsLoading={false}
      allIterations={[]}
      hostNamesById={new Map()}
      onRerun={vi.fn()}
      onEditSuite={vi.fn()}
      onImportCases={onImportCases}
      onRunClick={vi.fn()}
      onTestCaseClick={vi.fn()}
      rerunningSuiteId={null}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Import cases" }));
  expect(onImportCases).toHaveBeenCalledOnce();
});

it("opens SDK setup from the suite header", async () => {
  const onSetupSdk = vi.fn();
  renderWithProviders(
    <SuiteDetailOverview
      suite={makeSuite()}
      cases={[]}
      runs={[]}
      runsLoading={false}
      allIterations={[]}
      hostNamesById={new Map()}
      onRerun={vi.fn()}
      onEditSuite={vi.fn()}
      onSetupSdk={onSetupSdk}
      onEditCases={vi.fn()}
      onRunClick={vi.fn()}
      onTestCaseClick={vi.fn()}
      rerunningSuiteId={null}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Setup SDK" }));
  expect(onSetupSdk).toHaveBeenCalledTimes(1);
});
