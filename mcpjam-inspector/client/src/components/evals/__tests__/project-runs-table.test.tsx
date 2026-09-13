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
  /** The args the table asked the backend for, newest last. */
  queryArgs: [] as Array<Record<string, unknown>>,
  /** Whether the fake backend honours `origins`; off by default so tests
   *  about the loaded page see it unfiltered. */
  backendFiltersOrigins: false,
}));

const convexClient = { query: mocks.query };

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [{ hostId: "cursor", name: "Cursor" }] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: (_fn: unknown, args: Record<string, unknown>) => {
    mocks.queryArgs.push(args);
    // The platform chips are a QUERY argument, so the fake backend answers
    // them the way the real one does: by run origin, falling back to the
    // suite's provenance for a row that predates `testSuiteRun.source`.
    const origins = args.origins as string[] | undefined;
    const page = mocks.paginated.current;
    if (!mocks.backendFiltersOrigins || !origins?.length) return page;
    return {
      ...page,
      results: page.results.filter((row: ProjectRunRow) =>
        origins.includes(row.source ?? row.suiteSource ?? "ui"),
      ),
    };
  },
  useConvex: () => convexClient,
}));

/** The most recent query args — what the table is asking for right now. */
function latestQueryArgs(): Record<string, unknown> {
  return mocks.queryArgs[mocks.queryArgs.length - 1] ?? {};
}

import {
  ProjectRunsTable,
  PROJECT_RUNS_PAGE_SIZE,
} from "../project-runs-table";
import { GroupSummaryRow } from "../project-run-suite-groups";
import {
  formatRunHistoryDate,
  formatRunHistoryDateRange,
} from "../../evaluate/suite-detail-model";

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
  mocks.queryArgs.length = 0;
  mocks.backendFiltersOrigins = false;
});

describe("ProjectRunsTable", () => {
  it("filters embedded history and keeps pagination available for more matches", async () => {
    const user = userEvent.setup();
    mocks.backendFiltersOrigins = true;
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
    // Sent to the query, not applied to the loaded page: the backend answers
    // with the SDK runs alone, so there is no "of the loaded runs" caveat.
    expect(latestQueryArgs().origins).toEqual(["sdk"]);
    expect(screen.getByText(/1 of 1 loaded runs/)).toBeInTheDocument();
    expect(inTable().queryByText("UI")).toBeNull();
    expect(screen.queryByText(/Filtering the .* most recent runs/)).toBeNull();
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

  it("filters by origin THROUGH THE QUERY, not over the loaded page", async () => {
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
    // Nothing selected: no argument at all, so a backend that predates the
    // filter is unaffected.
    expect(latestQueryArgs()).not.toHaveProperty("origins");

    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "SDK", exact: true }),
    );
    await user.keyboard("{Escape}");
    expect(latestQueryArgs().origins).toEqual(["sdk"]);

    // …and the rows the query returned are rendered as they came. A second,
    // client-side predicate would be free to disagree with the one that chose
    // the page — which is exactly how "No runs match these filters" came to be
    // shown for a suite whose GitHub runs were simply further down.
    expect(inTable().getByText("CI suite")).toBeTruthy();
    expect(inTable().getByText("Playground suite")).toBeTruthy();
  });

  it("maps the GitHub chip onto both stored GitHub origins", async () => {
    const user = userEvent.setup();
    setRows([makeRow({ source: "github_check" })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "GitHub" }));
    // A PR check and an Actions job are the same thing to the person
    // filtering, and were never distinguishable in the badge either.
    expect(latestQueryArgs().origins).toEqual([
      "github_check",
      "github_action",
    ]);
  });

  it("keeps the chips reachable when a filter matches nothing", async () => {
    const user = userEvent.setup();
    mocks.backendFiltersOrigins = true;
    setRows([makeRow({ source: "sdk" })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "CLI" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "MCP" }));
    await user.keyboard("{Escape}");

    // The full-page "No runs yet" would both lie about the project and take
    // away the control needed to undo the filter.
    expect(latestQueryArgs().origins).toEqual([
      "cli",
      "mcp",
      "slack",
      "discord",
    ]);
    expect(
      screen.getByRole("button", { name: "Filter by platform" }),
    ).toBeTruthy();
    expect(screen.getByText("No runs match these filters.")).toBeTruthy();
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
    mocks.backendFiltersOrigins = true;
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    // Suite first: that filter runs over the loaded page.
    await user.click(screen.getByLabelText("Filter by suite"));
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(inTable().queryByText("Alpha")).toBeNull();
    expect(screen.getByText("1 of 2 loaded runs")).toBeVisible();
    // Then the platform: that one is a query argument, and the backend now
    // answers with the legacy row alone, which the suite filter hides.
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "SDK" }));
    await user.keyboard("{Escape}");
    expect(inTable().getByText("No runs match these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(inTable().getByText("Alpha")).toBeVisible();
    expect(inTable().getByText("Beta")).toBeVisible();
    // The legacy row carries no `source`; the backend resolves it from the
    // suite's provenance, so it survives the SDK filter on its own.
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "SDK" }));
    await user.keyboard("{Escape}");
    expect(inTable().getByText("SDK")).toBeVisible();
    expect(inTable().queryByText("Beta")).toBeNull();
    expect(screen.getByText("1 of 1 loaded runs")).toBeVisible();
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

  it("loads more pages, and no longer hedges about what the filter covered", async () => {
    const user = userEvent.setup();
    setRows([makeRow({ source: "sdk" })], "CanLoadMore");

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // Unfiltered: no caveat needed.
    expect(document.body.textContent).not.toContain("loaded so far");

    // Filtered by platform with pages outstanding: the chips are a query
    // argument, so an empty answer is a fact about the project, and the
    // "loaded so far" hedge must not appear for them.
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "UI", exact: true }),
    );
    await user.keyboard("{Escape}");
    expect(document.body.textContent).not.toContain("loaded so far");

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

  it("renders a caller-supplied empty instead of the default", () => {
    setRows([]);
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        emptyState={<div data-testid="custom-runs-empty">Start here</div>}
      />,
    );
    expect(screen.getByTestId("custom-runs-empty")).toBeTruthy();
    expect(screen.queryByText("No runs yet")).toBeNull();
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
    expect(screen.getByRole("heading", { name: "All Runs" })).toBeVisible();
    const headers = inTable()
      .getAllByRole("columnheader")
      .map((header) => header.textContent);
    expect(headers.slice(0, 2)).toEqual(["Date", "Run"]);
    expect(inTable().getByRole("columnheader", { name: "Date" })).toBeVisible();
    expect(inTable().getByRole("columnheader", { name: "Run" })).toBeVisible();
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
    const suite = inTable().getByRole("button", {
      name: "Collapse suite Checkout suite",
    });
    expect(suite).toBeVisible();
    expect(suite.closest("td")).toBe(
      suite.closest("tr")!.querySelectorAll("td")[0],
    );
    expect(suite).not.toHaveTextContent(/Nov/);
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
      await inTable().findByRole("button", { name: "#1", exact: true }),
    ).toBeVisible();
    expect(
      inTable().queryByRole("button", { name: "#2", exact: true }),
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
    mocks.backendFiltersOrigins = true;
    const user = userEvent.setup();
    render(
      <ProjectRunsTable
        projectId="proj_1"
        onSelectRun={vi.fn()}
        historyMetricsEnabled
      />,
    );
    await screen.findByTestId("project-run-history-metrics");
    await user.click(
      screen.getByRole("button", { name: "Filter by platform" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "SDK", exact: true }),
    );
    await user.keyboard("{Escape}");
    await screen.findByText(/1 of 2 loaded runs/);
    expect(latestQueryArgs().origins).toBeUndefined();
    const platform = screen.getByRole("button", { name: "Filter by platform" });
    expect(platform).toHaveClass("border-primary/40");
    const clear = screen.getByRole("button", { name: "Clear filters" });
    expect(clear.parentElement).not.toContainElement(
      screen.getByRole("heading", { name: "All Runs" }),
    );
    expect(clear.parentElement).toContainElement(platform);
    expect(
      clear.compareDocumentPosition(platform) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const metrics = screen.getByTestId("project-run-history-metrics");
    expect(within(metrics).getByText("2/2 passed")).toBeVisible();
    expect(within(metrics).queryByText(/failed iteration/)).toBeNull();
    expect(within(metrics).queryByText(/ pp$/)).toBeNull();
    expect(inTable().queryByText("UI suite")).toBeNull();
    expect(screen.getByText(/1 of 2 loaded runs/)).toBeVisible();
    await user.click(clear);
    expect(platform).not.toHaveClass("border-primary/40");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
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
    expect(screen.getByTestId("project-run-history-metrics")).toBeVisible();
    expect(screen.getByText(/1 of 2 loaded runs/)).toBeVisible();
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
    expect(screen.getByTestId("project-run-history-metrics")).toBeVisible();
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
    const suiteCells = suite.closest("tr")!.querySelectorAll("td");
    expect(suite.closest("td")).toBe(suiteCells[0]);
    expect(suiteCells[0]).not.toHaveTextContent(/Dec/);
    expect(suiteCells[0].querySelector("svg")).not.toBeNull();
    expect(suiteCells[1]).toHaveTextContent("Checkout suite");
    expect(suiteCells[1].querySelector("svg")).toBeNull();
    expect(suiteCells[1]).not.toHaveTextContent(
      formatRunHistoryDateRange(1000, 2000),
    );
    expect(within(suite.closest("tr")!).getByText("75%")).toBeVisible();
    expect(within(suite.closest("tr")!).getByText("3/4 passed")).toBeVisible();
    const run = screen.getByRole("button", { name: "#1", exact: true });
    const runCells = run.querySelectorAll("td");
    expect(runCells[0]).toHaveTextContent(formatRunHistoryDate(1000));
    expect(runCells[0]).not.toHaveTextContent("#");
    expect(runCells[1]).toHaveTextContent("#1");
    expect(runCells[1]).not.toHaveTextContent(formatRunHistoryDate(1000));
    expect(screen.queryByText(/Run group/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Run new", exact: true }),
    ).toBeNull();
    expect(screen.getByText("1 of 1 loaded runs")).toBeVisible();
    expect(within(run).getByText(/Cursor/)).toBeVisible();
    expect(within(run).getByText(/claude-fable-5/)).toBeVisible();
    expect(within(run).getByText(/ChatGPT/)).toBeVisible();
    expect(within(run).getByText(/gpt-5.1/)).toBeVisible();
    expect(
      within(run).queryByRole("button", { name: /Client model mapping/ }),
    ).toBeNull();
    expect(within(run).queryByText(/client : model pairings/i)).toBeNull();
    expect(onSelectRun).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("combobox", { name: "Filter by client" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Cursor", exact: true }),
    );
    expect(
      within(screen.getByRole("button", { name: "#1", exact: true })).getByText(
        /Cursor/,
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("button", { name: "#1", exact: true })).getByText(
        /ChatGPT/,
      ),
    ).toBeVisible();
    expect(screen.getByText("1 of 1 loaded runs")).toBeVisible();
    expect(
      screen.queryByText(/roll-ups across matching loaded runs/),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
    await user.click(suite);
    expect(
      screen.queryByRole("button", { name: "#1", exact: true }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Expand suite Checkout suite" }),
    );
    screen.getByRole("button", { name: "#1", exact: true }).focus();
    await user.keyboard("{Enter}");
    expect(onSelectRun).toHaveBeenCalledWith({
      suiteId: "suite_1",
      runId: "old",
    });
    await user.click(
      screen.getByRole("button", { name: "Collapse suite Checkout suite" }),
    );
    expect(
      screen.getByRole("button", { name: "Expand suite Checkout suite" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("omits dates on suite groups even when runs span days", async () => {
    arrangeHistory();
    const earliest = new Date(2026, 8, 8, 15, 25).getTime();
    const latest = new Date(2026, 8, 10, 12, 0).getTime();
    const rows = [
      makeRow({ _id: "late", createdAt: latest, runNumber: 2 }),
      makeRow({ _id: "early", createdAt: earliest, runNumber: 1 }),
    ];
    setRows(rows);
    mocks.query.mockImplementation(async (name, args: any) =>
      name === "testSuites:getTestSuiteRun"
        ? {
            ...rows.find((row) => row._id === args.runId),
            effectiveModelId: "gpt-5.1",
          }
        : { page: [], isDone: true, continueCursor: "" },
    );
    render(
      <ProjectRunsTable
        projectId="proj_1"
        historyMetricsEnabled
        onSelectRun={vi.fn()}
      />,
    );
    const suite = await screen.findByRole("button", {
      name: "Collapse suite Checkout suite",
    });
    expect(suite).not.toHaveTextContent(
      formatRunHistoryDateRange(earliest, latest),
    );
    expect(suite).not.toHaveTextContent("Checkout suite");
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
  it("groups platform badges by resolved origin and keeps their provenance", () => {
    render(
      <table>
        <tbody>
          <GroupSummaryRow
            rows={[
              makeRow({
                source: "api",
                launcher: { kind: "cli" },
              }),
              makeRow({
                _id: "run_bbbbbbbbbbbb",
                source: "api",
                launcher: { kind: "cli" },
              }),
              makeRow({
                _id: "run_cccccccccccc",
                source: "api",
                attribution: { surface: "mcp" },
              }),
            ]}
            details={new Map()}
            historyRows={new Map()}
            showGitContext={false}
            label="#1"
          />
        </tbody>
      </table>,
    );

    expect(screen.getAllByText("CLI")).toHaveLength(1);
    expect(screen.getByText("CLI").getAttribute("title")).toContain("declared");
    expect(screen.getByText("MCP").getAttribute("title")).toContain("verified");
    expect(screen.queryByText("API")).toBeNull();
  });

  it("shows only Git values shared by every run in a grouped launch", () => {
    const common = {
      commitSha: "abcdef123456",
      repositoryUrl: "https://github.com/acme/server",
      prUrl: "https://github.com/acme/server/pull/4764",
    };
    render(
      <table>
        <tbody>
          <GroupSummaryRow
            rows={[
              makeRow({
                source: "github_check",
                ciMetadata: {
                  ...common,
                  branch: "feature/one",
                  branchUrl:
                    "https://github.com/acme/server/tree/feature%2Fone",
                },
              }),
              makeRow({
                _id: "run_bbbbbbbbbbbb",
                source: "github_check",
                ciMetadata: {
                  ...common,
                  branch: "feature/two",
                  branchUrl:
                    "https://github.com/acme/server/tree/feature%2Ftwo",
                },
              }),
            ]}
            details={new Map()}
            historyRows={new Map()}
            showGitContext
            label="#1"
          />
        </tbody>
      </table>,
    );

    expect(screen.getByRole("link", { name: "abcdef1" })).toBeVisible();
    expect(screen.getByRole("link", { name: "#4764" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /feature\// })).toBeNull();
  });

  it("keeps Git values blank on suite summary rows", () => {
    render(
      <table>
        <tbody>
          <GroupSummaryRow
            rows={[
              makeRow({
                source: "github_check",
                ciMetadata: {
                  commitSha: "abcdef123456",
                  repositoryUrl: "https://github.com/acme/server",
                  branch: "main",
                  branchUrl: "https://github.com/acme/server/tree/main",
                  prUrl: "https://github.com/acme/server/pull/4764",
                },
              }),
            ]}
            details={new Map()}
            historyRows={new Map()}
            showGitContext
            label="Checkout suite"
            suite
          />
        </tbody>
      </table>,
    );

    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([false, true])(
    "shows a PR link in its own column (metrics: %s) without opening the eval run",
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
      expect(inTable().getByRole("columnheader", { name: "PR" })).toBeVisible();
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
      expect(within(link.closest("td")!).queryByText("GitHub")).toBeNull();
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
    expect(inTable().getByText("Commit")).toBeVisible();
    expect(inTable().getByText("PR")).toBeVisible();
    expect(inTable().getByText("Branch")).toBeVisible();
    expect(inTable().getByRole("link", { name: "main" })).toBeVisible();
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

/**
 * "Run by" names a person, and the person is not always the whole answer.
 *
 * A run made with an API key is attributed to the key's OWNER, so an automated
 * launch and that person clicking Run rendered identically. The key id is
 * minted by the backend from the credential the request authenticated with — a
 * fact, not a claim — so the cell can say which without guessing.
 */
describe("ProjectRunsTable — who ran it, and with what", () => {
  it("names the API key behind an automated run", () => {
    setRows([
      makeRow({
        source: "api",
        createdByName: "Ada",
        attribution: { surface: "rest", apiKeyId: "key_abcd3f9a" },
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    expect(inTable().getByText("Ada")).toBeTruthy();
    // The last four of the KEY ID. The secret is what the audit sanitizer
    // redacts, and the platform stores only the id here for that reason.
    expect(inTable().getByText("via API key ····3f9a")).toBeTruthy();
  });

  it("names the calling agent on an MCP run instead", () => {
    setRows([
      makeRow({
        source: "api",
        createdByName: "Ada",
        launcher: { kind: "mcp", client: "claude-code/1.2.3" },
        attribution: { surface: "mcp", apiKeyId: "key_abcd3f9a" },
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // "claude-code" tells you what to look at; "via API key ····3f9a" tells you
    // which key to rotate. On an agent run the first is the more useful one.
    expect(inTable().getByText("via claude-code/1.2.3")).toBeTruthy();
    expect(inTable().queryByText(/via API key/)).toBeNull();
  });

  it("names the agent on a Slack-attributed MCP run too", () => {
    setRows([
      makeRow({
        source: "api",
        createdByName: "Ada",
        launcher: { kind: "mcp", client: "mcpjam-slack/2.0.0" },
        attribution: { surface: "slack", apiKeyId: "key_abcd3f9a" },
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // `resolveRunOrigin` answers `slack` here — verified attribution outranks
    // the declared launcher, on purpose — so asking the ORIGIN whether this is
    // "an MCP run" said no, and hid the agent name for exactly the runs that
    // have one. The name lives on `launcher.client` either way.
    expect(inTable().getByText("via mcpjam-slack/2.0.0")).toBeTruthy();
    expect(inTable().queryByText(/via API key/)).toBeNull();
  });

  it("says nothing extra for a run someone started in the app", () => {
    setRows([makeRow({ source: "ui", createdByName: "Ada" })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    expect(inTable().getByText("Ada")).toBeTruthy();
    expect(inTable().queryByText(/^via /)).toBeNull();
  });

  it("renders a row from a backend that sends neither provenance field", () => {
    // The whole table must survive an older deployment: both keys absent, not
    // merely null.
    setRows([makeRow({ source: "api", createdByName: "Ada" })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(inTable().getByText("Ada")).toBeTruthy();
    expect(inTable().getByText("API")).toBeTruthy();
  });
});
