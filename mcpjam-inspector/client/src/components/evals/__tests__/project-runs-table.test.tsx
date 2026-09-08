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
  /** Every arg object the table handed the paginated query, in order. */
  queryArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: (_name: string, args: Record<string, unknown>) => {
    mocks.queryArgs.push(args);
    return mocks.paginated.current;
  },
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
    launcher: null,
    attribution: null,
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
  mocks.queryArgs.length = 0;
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

  it("asks the SERVER for the chosen origins instead of sieving the page", async () => {
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
    // Unfiltered: no `origins` at all, not an empty array — the query treats
    // absent as "no filter" and would have to special-case `[]` otherwise.
    expect(mocks.queryArgs.at(-1)).not.toHaveProperty("origins");

    await user.click(screen.getByRole("button", { name: "SDK" }));
    expect(mocks.queryArgs.at(-1)?.origins).toEqual(["sdk"]);

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    expect(mocks.queryArgs.at(-1)?.origins).toEqual(["github", "sdk"]);

    // And the rows the server returned are rendered UNTOUCHED. Re-filtering
    // them here would be a second implementation of the rule, and the one that
    // silently disagreed would be this one — which is how "No runs match these
    // filters" became a lie about runs that existed.
    expect(inTable().getByText("CI suite")).toBeTruthy();
    expect(inTable().getByText("Playground suite")).toBeTruthy();
  });

  it("offers a chip for every origin a client can produce", () => {
    setRows([makeRow()]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // Including the two that no `source` value can express: a CLI run and an
    // MCP run are both stamped `api`, and the old chip row — a hand-copied
    // list of `source` values — could not offer them at all.
    for (const label of [
      "CLI",
      "MCP",
      "GitHub",
      "SDK",
      "Scheduled",
      "UI",
      "API",
    ]) {
      expect(
        screen.getByRole("button", { name: label }),
        `no chip for ${label}`,
      ).toBeTruthy();
    }
  });

  it("badges a run by its declared launcher, and names the credential", () => {
    setRows([
      makeRow({
        _id: "run_cli1",
        source: "api",
        launcher: { kind: "cli", client: "mcpjam-cli" },
        attribution: { surface: "rest", apiKeyId: "key_live_abcd1234" },
        suiteName: "CLI suite",
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    const table = inTable();
    // NOT "API". Every CLI run is stamped `api`, so a badge reading the stamp
    // alone is true and useless.
    expect(table.getByText("CLI")).toBeTruthy();
    expect(table.getByText("via API key ····1234")).toBeTruthy();
  });

  it("prefers a VERIFIED channel over what the client declared", () => {
    setRows([
      makeRow({
        _id: "run_mcp1",
        source: "api",
        launcher: { kind: "cli", client: "mcpjam-cli" },
        attribution: { surface: "mcp", apiKeyId: "key_live_wxyz9999" },
        suiteName: "MCP suite",
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // The credential is the half nobody can forge, so where the two disagree
    // it wins.
    expect(inTable().getByText("MCP")).toBeTruthy();
    expect(inTable().queryByText("CLI")).toBeNull();
  });

  it("names the calling agent on an MCP run instead of the key id", () => {
    setRows([
      makeRow({
        _id: "run_mcp2",
        source: "api",
        launcher: { kind: "mcp", client: "claude-code/1.2.3" },
        attribution: { surface: "rest", apiKeyId: "key_live_abcd1234" },
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    // The more useful fact, and the one the key id cannot tell you.
    expect(inTable().getByText("claude-code/1.2.3")).toBeTruthy();
    expect(inTable().queryByText(/via API key/)).toBeNull();
  });

  it("badges a legacy row with neither column exactly as before", () => {
    setRows([
      makeRow({
        _id: "run_old1",
        source: null,
        launcher: null,
        attribution: null,
      }),
    ]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    // An older backend sends neither field, and a run that predates `source`
    // has always read as UI.
    expect(inTable().getByText("UI")).toBeTruthy();
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

  it("loads more pages, and no longer caveats a filter it does not apply", async () => {
    const user = userEvent.setup();
    setRows([makeRow({ source: "sdk" })], "CanLoadMore");

    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);
    expect(document.body.textContent).not.toContain("loaded so far");

    // The caveat existed because the chips sieved the loaded page: "no UI runs"
    // was a claim about this page wearing the clothes of a claim about the
    // project. The query applies them now, so there is nothing to caveat.
    await user.click(screen.getByRole("button", { name: "UI" }));
    expect(document.body.textContent).not.toContain("loaded so far");

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
