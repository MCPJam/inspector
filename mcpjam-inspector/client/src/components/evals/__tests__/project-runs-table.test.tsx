import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectRunRow } from "../project-runs-table";

const mocks = vi.hoisted(() => ({
  paginated: {
    current: {
      results: [] as unknown[],
      status: "Exhausted" as string,
      isLoading: false,
      loadMore: vi.fn(),
    },
  },
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: () => mocks.paginated.current,
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
});

describe("ProjectRunsTable", () => {
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
    expect(table.getByText("Metric")).toBeTruthy();
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

    await user.click(screen.getByRole("button", { name: "SDK" }));

    expect(inTable().getByText("CI suite")).toBeTruthy();
    expect(inTable().queryByText("Playground suite")).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "UI" }));
    expect(document.body.textContent).toContain("loaded so far");

    await user.click(screen.getByRole("button", { name: "Load more" }));
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
