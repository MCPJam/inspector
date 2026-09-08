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
  /** The args the table asked the backend for, newest last. */
  queryArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: (_fn: unknown, args: Record<string, unknown>) => {
    mocks.queryArgs.push(args);
    return mocks.paginated.current;
  },
}));

/** The most recent query args — what the table is asking for right now. */
function latestQueryArgs(): Record<string, unknown> {
  return mocks.queryArgs[mocks.queryArgs.length - 1] ?? {};
}

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

    await user.click(screen.getByRole("button", { name: "SDK" }));
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

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    // A PR check and an Actions job are the same thing to the person
    // filtering, and were never distinguishable in the badge either.
    expect(latestQueryArgs().origins).toEqual([
      "github_check",
      "github_action",
    ]);
  });

  it("keeps the chips reachable when a filter matches nothing", async () => {
    const user = userEvent.setup();
    setRows([makeRow({ source: "sdk" })]);
    render(<ProjectRunsTable projectId="proj_1" onSelectRun={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "CLI" }));
    setRows([]);
    await user.click(screen.getByRole("button", { name: "MCP" }));

    // The full-page "No runs yet" would both lie about the project and take
    // away the control needed to undo the filter.
    expect(screen.getByRole("button", { name: "CLI" })).toBeTruthy();
    expect(screen.getByText("No runs match these filters.")).toBeTruthy();
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

    await user.click(screen.getByRole("button", { name: "UI" }));
    // The caveat described a real limitation of filtering the loaded page.
    // The filter is a query argument now, so the hedge would be false comfort.
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
