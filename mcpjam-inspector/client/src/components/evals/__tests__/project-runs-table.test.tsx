import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectRunRow } from "../project-runs-table";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  paginated: {
    current: {
      results: [] as unknown[],
      status: "Exhausted" as string,
      isLoading: false,
      loadMore: vi.fn(),
    },
  },
}));

const convexClient = { query: mocks.query };

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [{ hostId: "cursor", name: "Cursor" }] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: () => mocks.paginated.current,
  useConvex: () => convexClient,
}));

import {
  ProjectRunsTable,
  PROJECT_RUNS_PAGE_SIZE,
} from "../project-runs-table";

function makeRow(overrides: Partial<ProjectRunRow> = {}): ProjectRunRow {
  return {
    _id: "run_aaaaaaaaaaaa",
    suiteId: "suite_1",
    suiteName: "Checkout suite",
    suiteSource: "sdk",
    runNumber: 1,
    status: "completed",
    result: "passed",
    summary: { total: 4, passed: 3, failed: 1, passRate: 75 },
    source: "sdk",
    ciMetadata: null,
    createdBy: "user_1",
    createdByName: "Ada",
    createdByImageUrl: null,
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_005_000,
    durationMs: 5_000,
    ...overrides,
  };
}

function setRows(results: ProjectRunRow[], status = "Exhausted") {
  mocks.paginated.current = {
    results,
    status,
    isLoading: false,
    loadMore: vi.fn(),
  };
}

/**
 * Scope assertions to the table. Source labels double as filter-chip text
 * and suite names double as select-option text, so an unscoped `getByText`
 * matches the control as readily as the row it is meant to be checking.
 */
function inTable() {
  return within(screen.getByRole("table"));
}

beforeEach(() => {
  setRows([]);
  mocks.query.mockReset();
});

describe("ProjectRunsTable", () => {
  it("filters embedded history and keeps pagination available for more matches", async () => {
    const user = userEvent.setup();
    setRows(
      [makeRow({ source: "sdk" }), makeRow({ _id: "run_ui", source: "ui" })],
      "CanLoadMore",
    );
    render(
      <ProjectRunsTable projectId="ws-1" onSelectRun={vi.fn()} embedded />,
    );
    expect(
      screen.getByRole("heading", { name: "Run history" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 of 2 loaded runs/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "SDK", exact: true }),
    );
    await user.keyboard("{Escape}");
    expect(screen.getByText(/1 of 2 loaded runs/)).toBeInTheDocument();
    expect(inTable().queryByText("UI")).toBeNull();
    expect(
      screen.getByText(/Filtering the 2 most recent runs/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Load more/ }));
    expect(mocks.paginated.current.loadMore).toHaveBeenCalledWith(
      PROJECT_RUNS_PAGE_SIZE,
    );
  });

  it("labels loading runs in the combined overview", () => {
    setRows([], "LoadingFirstPage");
    render(
      <ProjectRunsTable projectId="ws-1" onSelectRun={vi.fn()} embedded />,
    );
    expect(
      screen.getByRole("status", { name: "Loading runs" }),
    ).toBeInTheDocument();
  });

  it("renders runs from every origin in one list", () => {
    setRows([
      makeRow({ _id: "run_sdk1", source: "sdk", suiteName: "CI suite" }),
      makeRow({
        _id: "run_ui11",
        source: "ui",
        suiteName: "Playground suite",
        suiteSource: "ui",
      }),
      makeRow({ _id: "run_sch1", source: "schedule", suiteName: "Probe" }),
      makeRow({ _id: "run_gh11", source: "github_check", suiteName: "PR" }),
    ]);

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // The whole point of the surface: origin is metadata on a shared list,
    // not a separate tab per origin.
    const table = inTable();
    expect(table.getByText("SDK")).toBeTruthy();
    expect(table.getByText("UI")).toBeTruthy();
    expect(table.getByText("Scheduled")).toBeTruthy();
    expect(table.getByText("GitHub")).toBeTruthy();
    expect(table.getByText("Playground suite")).toBeTruthy();
  });

  it("labels each row's metric, since the column mixes both kinds", async () => {
    setRows([
      makeRow({ _id: "run_sdk1", source: "sdk", suiteName: "CI suite" }),
      makeRow({
        _id: "run_ui11",
        source: "ui",
        suiteSource: "ui",
        suiteName: "Playground suite",
      }),
    ]);

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // A single "Pass rate" header would mislabel the UI row — those report
    // per-iteration accuracy, not per-case pass rate. So the header is neutral
    // and the kind is rendered per row (not hidden in a `title`).
    const table = inTable();
    expect(table.getByText("Results")).toBeTruthy();
    expect(table.queryByText("Pass rate")).not.toBeNull();
    expect(table.queryByText("Accuracy")).not.toBeNull();
  });

  it("filters by source", async () => {
    const user = userEvent.setup();
    setRows([
      makeRow({ _id: "run_sdk1", source: "sdk", suiteName: "CI suite" }),
      makeRow({
        _id: "run_ui11",
        source: "ui",
        suiteName: "Playground suite",
      }),
    ]);

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(inTable().getByText("Playground suite")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "SDK", exact: true }),
    );
    await user.keyboard("{Escape}");

    expect(inTable().getByText("CI suite")).toBeTruthy();
    expect(inTable().queryByText("Playground suite")).toBeNull();
  });

  it("uses legacy suite provenance consistently and clears combined filters", async () => {
    const user = userEvent.setup();
    setRows([
      makeRow({
        _id: "legacy",
        source: null,
        suiteSource: "sdk",
        suiteId: "suite_a",
        suiteName: "Alpha",
      }),
      makeRow({
        _id: "ui",
        source: "ui",
        suiteId: "suite_b",
        suiteName: "Beta",
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "SDK" }));
    await user.keyboard("{Escape}");
    expect(inTable().getByText("SDK")).toBeVisible();
    expect(inTable().queryByText("Beta")).toBeNull();
    expect(screen.getByText("1 of 2 loaded runs")).toBeVisible();
    await user.click(screen.getByLabelText("Filter by suite"));
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(inTable().getByText("No runs match these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(inTable().getByText("Alpha")).toBeVisible();
    expect(inTable().getByText("Beta")).toBeVisible();
  });

  it("filters by suite", async () => {
    const user = userEvent.setup();
    setRows([
      makeRow({ _id: "run_a", suiteId: "suite_a", suiteName: "Alpha" }),
      makeRow({ _id: "run_b", suiteId: "suite_b", suiteName: "Beta" }),
    ]);

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    await user.click(screen.getByLabelText("Filter by suite"));
    await user.click(await screen.findByRole("option", { name: "Alpha" }));

    await waitFor(() => expect(inTable().queryByText("Beta")).toBeNull());
    expect(inTable().getByText("Alpha")).toBeTruthy();
  });

  it("navigates to the run's detail route on row click", async () => {
    const user = userEvent.setup();
    const onSelectRun = vi.fn();
    setRows([makeRow({ _id: "run_target", suiteId: "suite_target" })]);

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={onSelectRun} />);
    await user.click(screen.getByRole("button", { name: /^Run run_targ/ }));

    expect(onSelectRun).toHaveBeenCalledWith({
      suiteId: "suite_target",
      runId: "run_target",
    });
  });

  it("loads more pages and says what the filters actually cover", async () => {
    const user = userEvent.setup();
    setRows([makeRow({ source: "sdk" })], "CanLoadMore");

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // Unfiltered: no caveat needed.
    expect(document.body.textContent).not.toContain("loaded so far");

    // Filtered with pages outstanding: "no UI runs" would otherwise read as
    // a fact about the project rather than about the loaded rows.
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "UI", exact: true }),
    );
    await user.keyboard("{Escape}");
    expect(document.body.textContent).toContain("loaded so far");

    await user.click(screen.getByRole("button", { name: /Load more/ }));
    expect(mocks.paginated.current.loadMore).toHaveBeenCalledWith(
      PROJECT_RUNS_PAGE_SIZE,
    );
  });

  it("shows an empty state before any run exists", () => {
    setRows([]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(screen.getByText("No runs yet")).toBeTruthy();
  });

  it("shows a spinner, not an empty state, while the first page loads", () => {
    setRows([], "LoadingFirstPage");
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(screen.queryByText("No runs yet")).toBeNull();
  });

  it("renders a run whose suite was deleted rather than dropping the row", () => {
    setRows([makeRow({ suiteName: null, suiteSource: null, source: null })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(inTable().getByText("Deleted suite")).toBeTruthy();
    // No `source` at all is a legacy row — it still gets a badge.
    expect(inTable().getByText("UI")).toBeTruthy();
    // …but it is NOT presented as clickable: run detail renders inside its
    // suite, so there is nowhere for the click to land.
    expect(screen.queryByRole("button", { name: /^Run / })).toBeNull();
  });

  it("labels a terminal run whose result never advanced past pending", () => {
    // A run that died before finalize keeps `result: "pending"` while
    // `status` is already "failed". Reporting that as "Pending" describes a
    // finished, failed run as still in progress.
    setRows([makeRow({ status: "failed", result: "pending" })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(inTable().getByText("Failed")).toBeTruthy();
    expect(inTable().queryByText("Pending")).toBeNull();
  });
});

describe("project run history metrics", () => {
  function arrangeHistory() {
    const rows = [
      makeRow({
        _id: "new",
        source: "ui",
        suiteName: "UI suite",
        createdAt: 2000,
      }),
      makeRow({
        _id: "old",
        source: "sdk",
        suiteName: "SDK suite",
        suiteId: "suite_2",
        createdAt: 1000,
      }),
    ];
    setRows(rows);
    mocks.query.mockImplementation(async (name: string, args: any) => {
      if (name === "testSuites:getTestSuiteRun")
        return {
          ...rows.find((row) => row._id === args.runId),
          namedHostId: "cursor",
          effectiveModelId: "gpt-5.1",
          summary: {
            total: 2,
            passed: args.runId === "new" ? 1 : 2,
            failed: args.runId === "new" ? 1 : 0,
            passRate: 50,
          },
        };
      const second = args.paginationOpts.cursor === "next";
      return {
        page: [
          {
            _id: `${args.runId}-${second}`,
            suiteRunId: args.runId,
            status: "completed",
            result: second && args.runId === "new" ? "failed" : "passed",
            tokensUsed: 1000,
            startedAt: 1000,
            updatedAt: second ? 5000 : 3000,
            actualToolCalls: [{ toolName: "read", arguments: {} }],
          },
        ],
        isDone: second,
        continueCursor: second ? "" : "next",
      };
    });
  }

  it("renders the grouped table shell on the first page load", () => {
    setRows([], "LoadingFirstPage");
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    expect(
      inTable().getByRole("columnheader", { name: "Suite / Run / Date" }),
    ).toBeVisible();
    expect(
      inTable().getByRole("columnheader", { name: "Status" }),
    ).toBeVisible();
    expect(inTable().getByRole("status")).toHaveTextContent("Loading runs…");
    expect(screen.queryByText("No runs yet")).toBeNull();
  });

  it("keeps the suite shell until all members arrive, without fetching row verdicts", async () => {
    const rows = [
      makeRow({ _id: "first", runNumber: 1 }),
      makeRow({ _id: "second", runNumber: 2 }),
    ];
    setRows(rows);
    let release!: (value: unknown) => void;
    const delayed = new Promise((resolve) => {
      release = resolve;
    });
    mocks.query.mockImplementation(async (name: string, args: any) => {
      if (name === "testSuites:getTestSuiteRun") {
        if (args.runId === "second") return delayed;
        return { ...rows[0], runGroupId: "together" };
      }
      return { page: [], isDone: true, continueCursor: "" };
    });
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
        decisionSummaryEnabled
      />,
    );
    expect(
      inTable().getByRole("button", { name: "Collapse suite Checkout suite" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(mocks.query).toHaveBeenCalledWith(
        "testSuites:listTestSuiteRunIterations",
        expect.anything(),
      ),
    );
    expect(inTable().queryByRole("button", { name: /Run/ })).toBeNull();
    expect(inTable().queryByText("Verdict")).toBeNull();
    await act(async () => release({ ...rows[1], runGroupId: "together" }));
    expect(
      await inTable().findByRole("button", { name: "Run #1", exact: true }),
    ).toBeVisible();
    expect(
      inTable().queryByRole("button", { name: "Run #2", exact: true }),
    ).toBeNull();
    expect(
      mocks.query.mock.calls.every(([name]) =>
        [
          "testSuites:getTestSuiteRun",
          "testSuites:listTestSuiteRunIterations",
        ].includes(name),
      ),
    ).toBe(true);
  });

  it("reuses the suite charts and metrics table, reading every iteration page", async () => {
    arrangeHistory();
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    const metrics = await screen.findByTestId("project-run-history-metrics");
    expect(within(metrics).getByText("1/2 passed")).toBeVisible();
    expect(within(metrics).getByText("3.00s")).toBeVisible();
    expect(within(metrics).getByText("3.90s")).toBeVisible();
    expect(
      within(metrics).getByTestId("metric-sparkline-tokens"),
    ).toBeInTheDocument();
    const table = inTable();
    expect(table.getByText("Client : model")).toBeVisible();
    expect(table.getByText("Iteration pass")).toBeVisible();
    expect(table.getByText("Total tokens")).toBeVisible();
    expect(table.getAllByText("Cursor")).toHaveLength(4);
    expect(table.getAllByText("2k")).toHaveLength(4);
    expect(table.queryByText("Duration")).toBeNull();
    expect(mocks.query).toHaveBeenCalledWith(
      "testSuites:listTestSuiteRunIterations",
      {
        runId: "new",
        paginationOpts: { numItems: 200, cursor: "next" },
      },
    );
  });

  it("recalculates chart history and table rows when the source filter changes", async () => {
    arrangeHistory();
    const user = userEvent.setup();
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    await screen.findByText(/trends across 2 filtered runs/);
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "SDK", exact: true }),
    );
    await user.keyboard("{Escape}");
    await screen.findByText(/trends across 1 filtered runs/);
    const metrics = screen.getByTestId("project-run-history-metrics");
    expect(within(metrics).getByText("2/2 passed")).toBeVisible();
    expect(inTable().queryByText("UI suite")).toBeNull();
    expect(screen.getByText(/1 of 2 loaded runs/)).toBeVisible();
  });

  it("keeps unavailable metrics absent and lets the user retry", async () => {
    arrangeHistory();
    const success = mocks.query.getMockImplementation()!;
    mocks.query.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    await screen.findByText(/Metrics unavailable for 2 runs/);
    expect(screen.queryByTestId("project-run-history-metrics")).toBeNull();
    expect(inTable().queryByText("0%")).toBeNull();
    mocks.query.mockImplementation(success);
    await user.click(screen.getByRole("button", { name: "Retry metrics" }));
    await screen.findByTestId("project-run-history-metrics");
    expect(screen.queryByText(/Metrics unavailable/)).toBeNull();
  });

  it("filters rows and charts by recorded client and server while retaining the prior-run baseline", async () => {
    arrangeHistory();
    const original = mocks.query.getMockImplementation()!;
    // Same suite, different client/server configuration in each run.
    setRows([
      makeRow({ _id: "new", createdAt: 2000, runNumber: 2 }),
      makeRow({ _id: "old", createdAt: 1000, runNumber: 1 }),
    ]);
    mocks.query.mockImplementation(async (name, args: any) => {
      const result = await original(name, args);
      return name === "testSuites:getTestSuiteRun"
        ? {
            ...result,
            namedHostId: args.runId === "new" ? "cursor" : "chatgpt",
            configSnapshot: {
              tests: [],
              environment: {
                servers: args.runId === "new" ? ["Alpha", "Beta"] : ["Gamma"],
              },
            },
          }
        : result;
    });
    const user = userEvent.setup();
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    await screen.findByTestId("project-run-history-metrics");
    expect(
      screen.getByLabelText(
        "Down 50 percentage points versus run #1 in this suite",
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by client" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Cursor", exact: true }),
    );
    expect(screen.getByText(/1 of 2 loaded runs/)).toBeVisible();
    expect(
      screen.getByLabelText(
        "Down 50 percentage points versus run #1 in this suite",
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by server" }),
    );
    await user.click(screen.getByRole("option", { name: "Beta", exact: true }));
    expect(screen.getByText(/trends across 1 filtered runs/)).toBeVisible();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by server" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Gamma", exact: true }),
    );
    expect(screen.getByText("No runs match these filters.")).toBeVisible();
    expect(screen.queryByTestId("project-run-history-metrics")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText(/2 of 2 loaded runs/)).toBeVisible();
    expect(screen.getByText(/trends across 2 filtered runs/)).toBeVisible();
  });

  it("shows one complete run per row, preserves pairings when filtering, and opens its report", async () => {
    arrangeHistory();
    const original = mocks.query.getMockImplementation()!;
    const rows = [
      makeRow({ _id: "new", createdAt: 2000, runNumber: 2 }),
      makeRow({ _id: "old", createdAt: 1000, runNumber: 1 }),
    ];
    setRows(rows);
    mocks.query.mockImplementation(async (name, args: any) => {
      const result = await original(name, args);
      return name === "testSuites:getTestSuiteRun"
        ? {
            ...result,
            runGroupId: "shared-launch",
            namedHostId: args.runId === "new" ? "cursor" : "ChatGPT",
            effectiveModelId:
              args.runId === "new" ? "claude-fable-5" : "gpt-5.1",
          }
        : result;
    });
    const user = userEvent.setup();
    const onSelectRun = vi.fn();
    render(
      <ProjectRunsTable
        projectId="proj_1"
        historyMetricsEnabled
        onSelectRun={onSelectRun}
      />,
    );
    await screen.findByTestId("project-run-history-metrics");
    expect(screen.queryByText("Recent runs")).toBeNull();
    expect(screen.getAllByText("Checkout suite")).toHaveLength(1);
    const suite = screen.getByRole("button", {
      name: "Collapse suite Checkout suite",
    });
    expect(within(suite.closest("tr")!).getByText("75%")).toBeVisible();
    expect(within(suite.closest("tr")!).getByText("3/4 passed")).toBeVisible();
    const run = screen.getByRole("button", { name: "Run #1", exact: true });
    expect(screen.queryByText(/Run group/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Run new", exact: true }),
    ).toBeNull();
    expect(screen.getByText("1 of 1 loaded runs")).toBeVisible();
    const mapping = within(run).getByRole("button", {
      name: /Client model mapping/,
    });
    expect(mapping.querySelectorAll("img")).toHaveLength(2);
    await user.click(mapping);
    const popup = screen.getByRole("dialog");
    expect(within(popup).getByText("Cursor").parentElement).toHaveTextContent(
      "claude-fable-5",
    );
    expect(within(popup).getByText("ChatGPT").parentElement).toHaveTextContent(
      "gpt-5.1",
    );
    await user.keyboard("{Escape}");
    expect(onSelectRun).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by client" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Cursor", exact: true }),
    );
    expect(
      within(
        screen.getByRole("button", { name: "Run #1", exact: true }),
      ).getByText("Cursor, ChatGPT"),
    ).toBeVisible();
    expect(screen.getByText("1 of 1 loaded runs")).toBeVisible();
    await user.click(suite);
    expect(
      screen.queryByRole("button", { name: "Run #1", exact: true }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    screen.getByRole("button", { name: "Run #1", exact: true }).focus();
    await user.keyboard("{Enter}");
    expect(onSelectRun).toHaveBeenCalledWith({
      suiteId: "suite_1",
      runId: "old",
    });
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(
      screen.getByRole("button", { name: "Expand suite Checkout suite" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("limits long suite histories and preserves expansion when loading another page", async () => {
    arrangeHistory();
    const original = mocks.query.getMockImplementation()!;
    const rows = Array.from({ length: 7 }, (_, index) =>
      makeRow({
        _id: `run-${index}`,
        runNumber: index + 1,
        createdAt: index + 1,
      }),
    );
    setRows(rows, "CanLoadMore");
    mocks.query.mockImplementation(async (name, args: any) =>
      name === "testSuites:getTestSuiteRun"
        ? {
            ...rows.find((row) => row._id === args.runId),
            effectiveModelId: "gpt-5.1",
          }
        : original(name, args),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <ProjectRunsTable
        projectId="proj_1"
        historyMetricsEnabled
        onSelectRun={vi.fn()}
      />,
    );
    await screen.findByTestId("project-run-history-metrics");
    expect(screen.getAllByRole("button", { name: /^Run run-/ })).toHaveLength(
      5,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Show all 7 runs in Checkout suite",
      }),
    );
    expect(screen.getAllByRole("button", { name: /^Run run-/ })).toHaveLength(
      7,
    );
    await user.click(screen.getByRole("button", { name: "Show fewer runs" }));
    expect(screen.getAllByRole("button", { name: /^Run run-/ })).toHaveLength(
      5,
    );
    await user.click(
      screen.getByRole("button", { name: "Collapse suite Checkout suite" }),
    );
    await user.click(screen.getByRole("button", { name: /Load more/ }));
    expect(mocks.paginated.current.loadMore).toHaveBeenCalledWith(
      PROJECT_RUNS_PAGE_SIZE,
    );
    setRows([...rows, makeRow({ _id: "older", createdAt: 0 })]);
    rerender(
      <ProjectRunsTable
        projectId="proj_1"
        historyMetricsEnabled
        onSelectRun={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Expand suite Checkout suite" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Run run-/ })).toBeNull();
  });

  it("does not present a truncated iteration population as complete", async () => {
    arrangeHistory();
    const success = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (name, args: any) => {
      const value = await success(name, args);
      return name === "testSuites:getTestSuiteRun"
        ? value
        : { ...value, isDone: false, continueCursor: "repeated" };
    });
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    await screen.findByText(/Metrics unavailable for 2 runs/);
    expect(screen.queryByTestId("project-run-history-metrics")).toBeNull();
    expect(inTable().queryByText("2k")).toBeNull();
  });
});

describe("GitHub run context", () => {
  it.each([false, true])(
    "shows a PR link in the Platform cell (metrics: %s) without opening the eval run",
    async (historyMetricsEnabled) => {
      const user = userEvent.setup();
      const onSelectRun = vi.fn();
      mocks.query.mockImplementation(async (name: string, args: any) =>
        name === "testSuites:getTestSuiteRun"
          ? mocks.paginated.current.results.find(
              (row: any) => row._id === args.runId,
            )
          : { page: [], isDone: true, continueCursor: "" },
      );
      setRows([
        makeRow({
          source: "github_check",
          ciMetadata: { prUrl: "https://github.com/acme/server/pull/4674" },
        }),
        makeRow({ _id: "missing-pr", source: "github_check" }),
      ]);
      render(
        <ProjectRunsTable
          projectId="proj_1"
          onSelectRun={onSelectRun}
          historyMetricsEnabled={historyMetricsEnabled}
        />,
      );
      expect(
        inTable().getByRole("columnheader", { name: "Platform" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Filter by platform" }),
      ).toBeVisible();
      const link = await inTable().findByRole("link", {
        name: "#4674",
        exact: true,
      });
      expect(link).toHaveAttribute(
        "href",
        "https://github.com/acme/server/pull/4674",
      );
      expect(within(link.closest("td")!).getByText("GitHub")).toBeVisible();
      await user.click(link);
      link.focus();
      await user.keyboard("{Enter}");
      expect(onSelectRun).not.toHaveBeenCalled();
      expect(inTable().getAllByRole("link", { name: /^#/ })).toHaveLength(1);
    },
  );

  it("shows and filters recorded repository, branch, and commit without opening a run", async () => {
    const user = userEvent.setup();
    const onSelectRun = vi.fn();
    setRows([
      makeRow({
        _id: "github-main",
        source: "github_check",
        ciMetadata: {
          branch: "main",
          commitSha: "abcdef123456",
          runUrl: "https://github.com/acme/server/actions/runs/100",
        },
      }),
      makeRow({
        _id: "github-feature",
        source: "github_check",
        ciMetadata: {
          branch: "feature",
          commitSha: "123456abcdef",
          runUrl: "https://github.com/acme/other/actions/runs/101",
        },
      }),
      makeRow({
        _id: "github-missing",
        source: "github_check",
        ciMetadata: null,
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={onSelectRun} />);
    expect(inTable().getByText("Git / CI")).toBeVisible();
    expect(inTable().getByText("Not recorded")).toBeVisible();
    expect(inTable().getByText("main")).toBeVisible();
    expect(inTable().getByText("abcdef1")).toBeVisible();
    // Link clicks and keyboard activation must not also navigate to the eval run.
    const link = screen.getByRole("link", { name: "abcdef1" });
    await user.click(link);
    link.focus();
    await user.keyboard("{Enter}");
    expect(onSelectRun).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by repository" }),
    );
    await user.click(
      screen.getByRole("option", { name: "acme/server", exact: true }),
    );
    expect(screen.getByText(/1 of 3 loaded runs/)).toBeVisible();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by branch" }),
    );
    await user.click(screen.getByRole("option", { name: "main", exact: true }));
    await user.type(
      screen.getByRole("textbox", { name: "Filter by commit" }),
      "ABCDEF",
    );
    expect(screen.getByText(/1 of 3 loaded runs/)).toBeVisible();
    await user.type(
      screen.getByRole("textbox", { name: "Filter by commit" }),
      "000",
    );
    expect(screen.getByText("No runs match these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText(/3 of 3 loaded runs/)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Filter by commit" }),
    ).toHaveValue("");
  });
});
