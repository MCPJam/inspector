import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConformanceRunListItem } from "../ConformanceHistory";

const { navigateMock, startRun, useQueryMock, tableRenders } = vi.hoisted(
  () => ({
    navigateMock: vi.fn(),
    startRun: vi.fn().mockResolvedValue({ runId: "run_new" }),
    useQueryMock: vi.fn(),
    /** Every render's row ids and dimming, including ones no assertion sees. */
    tableRenders: [] as Array<{ ids: string[]; dimmed: boolean }>,
  }),
);

vi.mock("../ConformanceHistoryTable", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../ConformanceHistoryTable")>();
  return {
    ...actual,
    ConformanceHistoryTable: (
      props: Parameters<typeof actual.ConformanceHistoryTable>[0],
    ) => {
      tableRenders.push({
        ids: props.rows.map((row) => row._id),
        dimmed: props.dimmed,
      });
      return actual.ConformanceHistoryTable(props);
    },
  };
});

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (name: string) => {
    if (name === "conformanceRuns:startRun") return startRun;
    return vi.fn();
  },
  useAction: () => vi.fn(),
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return {
    ...actual,
    useAppNavigate: () => navigateMock,
  };
});

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

import { ConformanceHistory } from "../ConformanceHistory";
import { ConformanceRunRequestContext } from "../conformance-run-request";

function makeRun(
  overrides: Partial<ConformanceRunListItem> = {},
): ConformanceRunListItem {
  return {
    _id: "run_existing",
    projectId: "proj_1",
    targetKind: "server",
    targetKey: "server:srv_1",
    serverId: "srv_1",
    source: "ui",
    verification: "client_reported",
    status: "completed",
    outcome: "incomplete",
    incompleteReason: null,
    score: null,
    applicable: 4,
    passed: 0,
    failed: 0,
    couldNotRun: 4,
    requestedSuites: ["protocol", "apps", "tasks", "oauth"],
    protocolVersion: null,
    actorLabel: "Inspector UI",
    ciMetadata: null,
    createdAt: Date.now() - 60_000,
    completedAt: Date.now() - 60_000,
    durationMs: 0,
    sharingEnabled: false,
    ...overrides,
  };
}

describe("ConformanceHistory", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    startRun.mockClear();
    useQueryMock.mockReturnValue({
      page: [makeRun()],
      isDone: true,
      continueCursor: "",
    });
  });

  it("opens an existing run instead of starting a new one", async () => {
    const user = userEvent.setup();
    // A Convex-id-shaped project: the run link carries the project in its
    // PATH now, and the builder refuses to put an unusable id there.
    const projectId = "k5700000000000000000000000a";
    render(<ConformanceHistory projectId={projectId} />);

    await user.click(screen.getByTestId("conformance-history-row"));

    // Not `?project=`: a run link has to reopen the same project on a
    // refresh, which a query the app consumes and strips cannot do.
    expect(navigateMock).toHaveBeenCalledWith(
      `/p/${projectId}/conformance/runs/run_existing`,
      { state: { conformanceRunFrom: "history" } },
    );
    expect(startRun).not.toHaveBeenCalled();
  });

  it("shows each run's result as a ring of its checks", () => {
    useQueryMock.mockReturnValue({
      page: [
        makeRun({
          passed: 19,
          failed: 2,
          applicable: 21,
          outcome: "failed",
          score: 90.4,
        }),
      ],
      isDone: true,
      continueCursor: "",
    });
    render(<ConformanceHistory projectId="proj_1" />);

    expect(
      screen.getByRole("img", { name: "19 passed, 2 failed of 21" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("FAILED")).toBeNull();
    const header = screen.getByTestId(
      "conformance-history-sort-server",
    ).parentElement;
    expect(header?.textContent).toBe(
      "SERVERPROTOCOLSCORECHECKSRESULTDATESOURCE",
    );
  });

  it("names a CLI run by the URL it ran against, not its storage key", () => {
    useQueryMock.mockReturnValue({
      page: [
        makeRun({
          targetKind: "external",
          targetKey: "url:https://mcp.example.com/mcp",
          serverId: null,
          source: "cli",
        }),
      ],
      isDone: true,
      continueCursor: "",
    });
    render(<ConformanceHistory projectId="proj_1" />);

    expect(screen.getByText("https://mcp.example.com/mcp")).toBeInTheDocument();
    expect(screen.queryByText(/^url:/)).toBeNull();
  });

  it("names a run that has not finished instead of drawing an empty ring", () => {
    const unfinished = { applicable: 0, passed: 0, failed: 0, couldNotRun: 0 };
    useQueryMock.mockReturnValue({
      page: [
        makeRun({ _id: "run_q", status: "queued", ...unfinished }),
        makeRun({ _id: "run_c", status: "cancelled", ...unfinished }),
        makeRun({ _id: "run_t", status: "timed_out", ...unfinished }),
      ],
      isDone: true,
      continueCursor: "",
    });
    render(<ConformanceHistory projectId="proj_1" />);

    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText("CANCELLED")).toBeInTheDocument();
    expect(screen.getByText("TIMED OUT")).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "No applicable checks" }),
    ).toBeNull();
  });

  it("keeps the empty state compact so the suites below stay visible", () => {
    useQueryMock.mockReturnValue({
      page: [],
      isDone: true,
      continueCursor: "",
    });
    render(<ConformanceHistory projectId="proj_1" />);

    // The history sits in a shrink-0 container above the suites; a
    // viewport-height empty state pushed them out of view.
    const emptyState = screen.getByTestId("conformance-history-empty");
    expect(emptyState.textContent).toContain("No conformance runs yet");
    expect(emptyState.outerHTML).not.toMatch(/100vh/);
    // Overview's empty state, sample score card and all.
    expect(emptyState.textContent).toContain("OVERALL SCORE");
  });

  it("keeps loaded rows while the next page loads", async () => {
    const user = userEvent.setup();
    // Convex reads undefined again whenever the cursor changes. The first
    // page is one object, as Convex returns it: a fresh one per render would
    // re-fire the rows effect forever.
    const firstPage = {
      page: [makeRun()],
      isDone: false,
      continueCursor: "cursor_2",
    };
    useQueryMock.mockImplementation(
      (_name: string, args: { paginationOpts: { cursor: string | null } }) =>
        args.paginationOpts.cursor === null ? firstPage : undefined,
    );
    render(<ConformanceHistory projectId="proj_1" />);

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(screen.queryByTestId("conformance-history-loading")).toBeNull();
    expect(screen.getAllByTestId("conformance-history-row")).toHaveLength(1);
    // The button keeps its label and spins: no text swap that resizes it.
    const loadMore = screen.getByRole("button", { name: "Load more" });
    expect(loadMore).toBeDisabled();
    expect(loadMore.getAttribute("aria-busy")).toBe("true");
  });
});

describe("ConformanceHistory — search, filter and sort (CQT-113)", () => {
  type ListArgs = {
    targetKey?: string;
    paginationOpts: { numItems: number; cursor: string | null };
  };
  type Page = {
    page: ConformanceRunListItem[];
    isDone: boolean;
    continueCursor: string;
  };

  const serverNames = new Map([
    ["srv_beta", "Beta"],
    ["srv_alpha", "Alpha"],
  ]);
  const run = (
    id: string,
    serverId: string,
    protocolVersion: string,
    createdAt: number,
  ) =>
    makeRun({
      _id: id,
      serverId,
      targetKey: `server:${serverId}`,
      protocolVersion,
      createdAt,
    });

  /** One object per page, as Convex returns it, so effects settle. */
  function servePages(pages: (args: ListArgs) => Page | undefined) {
    useQueryMock.mockImplementation((_name: string, args: ListArgs | "skip") =>
      args === "skip" ? undefined : pages(args),
    );
  }

  const lastListArgs = () =>
    useQueryMock.mock.calls[useQueryMock.mock.calls.length - 1][1] as ListArgs;
  const rowTexts = () =>
    screen
      .getAllByTestId("conformance-history-row")
      .map((row) => row.textContent);

  async function choose(testId: string, option: string) {
    const user = userEvent.setup();
    await user.click(screen.getByTestId(testId));
    await user.click(await screen.findByRole("option", { name: option }));
  }

  beforeEach(() => {
    useQueryMock.mockReset();
  });

  it("filters by server on the backend, so every page is that server's", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    const alphaOnly: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages((args) =>
      args.targetKey === "server:srv_alpha" ? alphaOnly : all,
    );
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("conformance-history-server-filter"));
    // Servers listed by name, after "All servers".
    expect(
      (await screen.findAllByRole("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["All servers", "Alpha", "Beta"]);
    await user.click(screen.getByRole("option", { name: "Alpha" }));

    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain("Alpha");
    expect(lastListArgs()).toMatchObject({
      targetKey: "server:srv_alpha",
      paginationOpts: { cursor: null },
    });
  });

  it("says a filtered server has no runs and keeps the filter to clear it", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    const none: Page = { page: [], isDone: true, continueCursor: "" };
    servePages((args) => (args.targetKey ? none : all));
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    await choose("conformance-history-server-filter", "Alpha");

    expect(
      await screen.findByRole("heading", { name: "No runs for Alpha yet" }),
    ).toBeDefined();
    expect(screen.queryByText("No conformance runs yet")).toBeNull();

    await choose("conformance-history-server-filter", "All servers");
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
  });

  it("searches every run, not just the page loaded so far", async () => {
    const first: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 3)],
      isDone: false,
      continueCursor: "cursor_2",
    };
    const second: Page = {
      page: [run("b1", "srv_beta", "2025-06-18", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages((args) =>
      args.paginationOpts.cursor === "cursor_2" ? second : first,
    );
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    expect(rowTexts()).toHaveLength(1);

    const user = userEvent.setup();
    await user.type(screen.getByTestId("conformance-history-search"), "beta");

    // Beta's run is on the second page: the search loaded it.
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    await waitFor(() => expect(rowTexts()[0]).toContain("Beta"));
    expect(
      useQueryMock.mock.calls.some(
        ([, args]) =>
          args !== "skip" &&
          (args as ListArgs).paginationOpts.cursor === "cursor_2",
      ),
    ).toBe(true);
    // Every run is loaded, so there is nothing more to page through.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("matches protocol and source as well as the server name", async () => {
    const page: Page = {
      page: [
        run("a1", "srv_alpha", "2025-11-25", 2),
        makeRun({ ...run("b1", "srv_beta", "2025-06-18", 1), source: "cli" }),
      ],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    const user = userEvent.setup();
    const search = screen.getByTestId("conformance-history-search");

    await user.type(search, "2025-06");
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain("Beta");

    await user.clear(search);
    await user.type(search, "cli");
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain("Beta");
  });

  it("says when no run matches the search", async () => {
    const page: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    const user = userEvent.setup();
    await user.type(screen.getByTestId("conformance-history-search"), "zzz");

    const empty = await screen.findByTestId("conformance-history-empty");
    expect(
      within(empty).getByRole("heading", { name: "No runs match “zzz”" }),
    ).toBeDefined();
    expect(empty.textContent).toContain(
      "Try another search, or clear it to see every run.",
    );
    // Overview's empty state, sample score card and all.
    expect(empty.textContent).toContain("OVERALL SCORE");
    expect(screen.queryByTestId("conformance-history-row")).toBeNull();
    // Outside the Conformance page there is no run to start.
    expect(
      screen.queryByRole("button", { name: "Run conformance checks" }),
    ).toBeNull();

    await user.click(
      within(empty).getByRole("button", { name: "Clear search" }),
    );
    expect(
      (screen.getByTestId("conformance-history-search") as HTMLInputElement)
        .value,
    ).toBe("");
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
  });

  it("starts a run from the empty search, like the page's run button", async () => {
    const page: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    const runRequest = vi.fn();
    render(
      <ConformanceRunRequestContext.Provider
        value={{ run: runRequest, disabled: false }}
      >
        <ConformanceHistory projectId="proj_1" serverNames={serverNames} />
      </ConformanceRunRequestContext.Provider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByTestId("conformance-history-search"), "zzz");

    await user.click(
      await screen.findByRole("button", { name: "Run conformance checks" }),
    );
    expect(runRequest).toHaveBeenCalledTimes(1);
  });

  it("clears the server filter from its empty state", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    const none: Page = { page: [], isDone: true, continueCursor: "" };
    servePages((args) => (args.targetKey ? none : all));
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    await choose("conformance-history-server-filter", "Alpha");
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "Clear server filter" }),
      );

    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain("Beta");
  });

  it("sorts by server name from its header, each server's runs newest first", async () => {
    const page: Page = {
      page: [
        run("b_new", "srv_beta", "2025-11-25", 4),
        run("a_new", "srv_alpha", "2025-11-25", 3),
        run("b_old", "srv_beta", "2025-06-18", 2),
        run("a_old", "srv_alpha", "2025-06-18", 1),
      ],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    expect(rowTexts()[0]).toContain("Beta");

    await userEvent.setup().click(
      screen.getByTestId("conformance-history-sort-server"),
    );

    await waitFor(() => expect(rowTexts()[0]).toContain("Alpha"));
    expect(
      rowTexts().map((text) => [
        text?.includes("Alpha") ? "Alpha" : "Beta",
        text?.includes("2025-11-25") ? "new" : "old",
      ]),
    ).toEqual([
      ["Alpha", "new"],
      ["Alpha", "old"],
      ["Beta", "new"],
      ["Beta", "old"],
    ]);
  });

  const listCalls = () =>
    useQueryMock.mock.calls
      .map(([, args]) => args)
      .filter((args): args is ListArgs => args !== "skip");

  it("goes back to the live first page once the search is cleared", async () => {
    const first: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 3)],
      isDone: false,
      continueCursor: "cursor_2",
    };
    const second: Page = {
      page: [run("b1", "srv_beta", "2025-06-18", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages((args) =>
      args.paginationOpts.cursor === "cursor_2" ? second : first,
    );
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    const user = userEvent.setup();
    const search = screen.getByTestId("conformance-history-search");

    await user.type(search, "beta");
    await waitFor(() => expect(rowTexts()[0]).toContain("Beta"));
    expect(lastListArgs().paginationOpts.cursor).toBe("cursor_2");

    // Left on the last page, the query would no longer watch the newest runs.
    await user.clear(search);
    await waitFor(() =>
      expect(lastListArgs().paginationOpts).toEqual({
        numItems: 20,
        cursor: null,
      }),
    );
    await waitFor(() => expect(rowTexts()).toHaveLength(1));
    expect(rowTexts()[0]).toContain("Alpha");
    expect(screen.getByRole("button", { name: "Load more" })).toBeDefined();
  });

  it("keeps the toolbar up while All servers reloads", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    const alphaOnly: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 1)],
      isDone: true,
      continueCursor: "",
    };
    // Convex reads undefined for new args until the backend answers.
    let allLoaded = true;
    servePages((args) =>
      args.targetKey ? alphaOnly : allLoaded ? all : undefined,
    );
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    await choose("conformance-history-server-filter", "Alpha");
    await waitFor(() => expect(rowTexts()[0]).toContain("Alpha"));

    allLoaded = false;
    await choose("conformance-history-server-filter", "All servers");

    expect(screen.getByTestId("conformance-history-search")).toBeDefined();
    expect(
      screen.getByTestId("conformance-history-server-filter"),
    ).toBeDefined();
    // The app's loading state where the table goes.
    const loader = screen.getByTestId("conformance-history-loading");
    expect(loader.getAttribute("role")).toBe("status");
    expect(loader.textContent).toBe("Loading...");
  });

  it("shows the app's centered loading state on the first load", () => {
    servePages(() => undefined);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    const loader = screen.getByTestId("conformance-history-loading");
    expect(loader.className).toContain("justify-center");
    expect(loader.querySelector(".animate-spin")).not.toBeNull();
    expect(loader.textContent).toBe("Loading...");
  });

  it("does not read every run to sort one server's runs by name", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    const alphaFirst: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 2)],
      isDone: false,
      continueCursor: "alpha_2",
    };
    servePages((args) => (args.targetKey ? alphaFirst : all));
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    await choose("conformance-history-server-filter", "Alpha");
    await waitFor(() => expect(rowTexts()[0]).toContain("Alpha"));
    await userEvent.setup().click(
      screen.getByTestId("conformance-history-sort-server"),
    );

    // Every row is Alpha's: the sort changes nothing, so nothing more loads.
    expect(
      listCalls().some((args) => args.paginationOpts.cursor === "alpha_2"),
    ).toBe(false);
    expect(
      listCalls().some((args) => args.paginationOpts.numItems === 100),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Load more" })).toBeDefined();
  });

  it("does not reload a complete list to search it", async () => {
    const page: Page = {
      page: [
        run("a1", "srv_alpha", "2025-11-25", 2),
        run("b1", "srv_beta", "2025-06-18", 1),
      ],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("conformance-history-search"), "beta");
    await waitFor(() => expect(rowTexts()).toHaveLength(1));

    expect(
      listCalls().some((args) => args.paginationOpts.numItems === 100),
    ).toBe(false);
    expect(screen.queryByText("Loading every run…")).toBeNull();
  });

  it("announces when a filtered server or a search has no runs", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    const none: Page = { page: [], isDone: true, continueCursor: "" };
    servePages((args) => (args.targetKey ? none : all));
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("conformance-history-search"), "zzz");
    const announced = () =>
      screen
        .getAllByRole("status")
        .map((status) => status.textContent)
        .join(" ");
    await screen.findByTestId("conformance-history-empty");
    expect(announced()).toContain("No runs match “zzz”");

    await user.clear(screen.getByTestId("conformance-history-search"));
    await choose("conformance-history-server-filter", "Alpha");
    await waitFor(() => expect(announced()).toContain("No runs for Alpha yet"));
  });

  it("sorts from the column headers, not a sort dropdown", () => {
    const page: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);

    expect(screen.queryByTestId("conformance-history-sort")).toBeNull();
    // Newest first is the default, and Date says so.
    expect(
      screen
        .getByTestId("conformance-history-sort-date")
        .getAttribute("data-sort-direction"),
    ).toBe("desc");
    expect(
      screen
        .getByTestId("conformance-history-sort-server")
        .getAttribute("data-sort-direction"),
    ).toBeNull();
  });

  it("flips Date to oldest first, reading every run to do it", async () => {
    const first: Page = {
      page: [
        run("a3", "srv_alpha", "2025-11-25", 3),
        run("b2", "srv_beta", "2025-11-25", 2),
      ],
      isDone: false,
      continueCursor: "cursor_2",
    };
    const second: Page = {
      page: [run("a1", "srv_alpha", "2025-06-18", 1)],
      isDone: true,
      continueCursor: "",
    };
    servePages((args) =>
      args.paginationOpts.cursor === "cursor_2" ? second : first,
    );
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    expect(rowTexts()).toHaveLength(2);

    const date = screen.getByTestId("conformance-history-sort-date");
    await userEvent.setup().click(date);

    // The oldest run was on the second page: the sort loaded it and leads.
    await waitFor(() => expect(rowTexts()).toHaveLength(3));
    expect(rowTexts()[0]).toContain("2025-06-18");
    expect(date.getAttribute("data-sort-direction")).toBe("asc");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("points the sorted column's chevron the way it is sorted", async () => {
    const page: Page = {
      page: [run("a1", "srv_alpha", "2025-11-25", 2)],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    // The header's name says the direction; its icon is aria-hidden.
    const header = (name: string) => screen.getByRole("button", { name });
    const icon = (button: HTMLElement) =>
      button
        .querySelector('[data-testid="conformance-history-sort-icon"]')
        ?.getAttribute("class") ?? "";

    // Newest first by default: Date points down, the others show both ways.
    expect(icon(header("Date, sorted descending"))).toContain(
      "lucide-chevron-down",
    );
    expect(icon(header("Sort by server"))).toContain("lucide-chevrons-up-down");
    expect(icon(header("Sort by score"))).toContain("lucide-chevrons-up-down");

    await userEvent.setup().click(header("Date, sorted descending"));
    await waitFor(() =>
      expect(icon(header("Date, sorted ascending"))).toContain(
        "lucide-chevron-up",
      ),
    );
  });

  it("waits for every run after a server switch instead of showing part of a sort", async () => {
    const all: Page = {
      page: [run("b1", "srv_beta", "2025-11-25", 9)],
      isDone: true,
      continueCursor: "",
    };
    const scored = (id: string, score: number, createdAt: number) =>
      makeRun({ ...run(id, "srv_alpha", id, createdAt), score });
    const alphaFirst: Page = {
      page: [scored("a_low", 10, 3)],
      isDone: false,
      continueCursor: "alpha_2",
    };
    const alphaSecond: Page = {
      page: [scored("a_high", 90, 1)],
      isDone: true,
      continueCursor: "",
    };
    // Convex reads undefined for Alpha's second page until the backend answers.
    let alphaSecondLoaded = false;
    servePages((args) =>
      !args.targetKey
        ? all
        : args.paginationOpts.cursor === "alpha_2"
          ? alphaSecondLoaded
            ? alphaSecond
            : undefined
          : alphaFirst,
    );
    const { rerender } = render(
      <ConformanceHistory projectId="proj_1" serverNames={serverNames} />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sort by score" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Score, sorted descending" }),
      ).toBeDefined(),
    );

    await choose("conformance-history-server-filter", "Alpha");
    await waitFor(() =>
      expect(lastListArgs().paginationOpts.cursor).toBe("alpha_2"),
    );

    // Only Alpha's lower score is in: no table with it on top, the loader.
    expect(screen.queryByTestId("conformance-history-row")).toBeNull();
    expect(screen.getByTestId("conformance-history-loading")).toBeDefined();

    alphaSecondLoaded = true;
    rerender(
      <ConformanceHistory projectId="proj_1" serverNames={serverNames} />,
    );
    await waitFor(() => expect(rowTexts()).toHaveLength(2));
    expect(rowTexts()[0]).toContain("a_high");
    expect(screen.queryByTestId("conformance-history-loading")).toBeNull();
  });

  it("holds the table still while a sort reads every run, then reorders once", async () => {
    const first: Page = {
      page: [
        run("a3", "srv_alpha", "2025-11-25", 3),
        run("b2", "srv_beta", "2025-10-01", 2),
      ],
      isDone: false,
      continueCursor: "cursor_2",
    };
    const second: Page = {
      page: [run("a1", "srv_alpha", "2025-06-18", 1)],
      isDone: true,
      continueCursor: "",
    };
    // Convex reads undefined for the second page until the backend answers.
    let secondLoaded = false;
    servePages((args) =>
      args.paginationOpts.cursor === "cursor_2"
        ? secondLoaded
          ? second
          : undefined
        : first,
    );
    const { rerender } = render(
      <ConformanceHistory projectId="proj_1" serverNames={serverNames} />,
    );
    const newestFirst = rowTexts();

    const date = screen.getByTestId("conformance-history-sort-date");
    await userEvent.setup().click(date);
    await waitFor(() =>
      expect(lastListArgs().paginationOpts.cursor).toBe("cursor_2"),
    );

    // Not the loaded runs sorted oldest first: the last complete order stays.
    expect(rowTexts()).toEqual(newestFirst);
    expect(
      screen.getByTestId("conformance-history-sort-loading"),
    ).toBeInTheDocument();
    // Announced, but not as a line that pushes the table down.
    expect(screen.getByRole("status").textContent).toBe("Loading every run…");
    expect(screen.getByRole("status").className).toContain("sr-only");

    tableRenders.length = 0;
    secondLoaded = true;
    rerender(
      <ConformanceHistory projectId="proj_1" serverNames={serverNames} />,
    );

    await waitFor(() => expect(rowTexts()).toHaveLength(3));
    expect(rowTexts()[0]).toContain("2025-06-18");
    expect(rowTexts()[2]).toContain("2025-11-25");
    expect(screen.queryByTestId("conformance-history-sort-loading")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
    // The last page arrives a render before it is in the rows. No render in
    // between may show the first two runs sorted oldest first ("b2", "a3"):
    // the held order stays, dimmed, until the full order replaces it.
    const orders = new Set(
      tableRenders.map(({ ids, dimmed }) => `${ids.join(",")}:${dimmed}`),
    );
    expect([...orders]).toEqual(["a3,b2:true", "a1,b2,a3:false"]);
  });

  it("sorts Score highest first, then lowest, runs without a score last", async () => {
    const scored = (id: string, score: number | null, createdAt: number) =>
      makeRun({ ...run(id, "srv_alpha", id, createdAt), score });
    const page: Page = {
      page: [
        scored("none", null, 4),
        scored("mid", 50, 3),
        scored("high", 98, 2),
        scored("low", 5, 1),
      ],
      isDone: true,
      continueCursor: "",
    };
    servePages(() => page);
    render(<ConformanceHistory projectId="proj_1" serverNames={serverNames} />);
    const user = userEvent.setup();
    const score = screen.getByTestId("conformance-history-sort-score");
    // The protocol column shows each run's id here.
    const order = () =>
      rowTexts().map(
        (text) => ["none", "mid", "high", "low"].find((id) => text?.includes(id))!,
      );

    await user.click(score);
    await waitFor(() => expect(order()).toEqual(["high", "mid", "low", "none"]));

    await user.click(score);
    await waitFor(() => expect(order()).toEqual(["low", "mid", "high", "none"]));
  });
});
