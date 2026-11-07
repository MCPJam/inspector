import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConformanceRunListItem } from "../ConformanceHistory";

const { navigateMock, startRun, useQueryMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  startRun: vi.fn().mockResolvedValue({ runId: "run_new" }),
  useQueryMock: vi.fn(),
}));

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
    const header = screen.getByText("SERVER").parentElement;
    expect(header?.textContent).toBe(
      "SERVERPROTOCOLSCORECHECKSRESULTDATESOURCE",
    );
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
    const emptyState = screen
      .getByText("No conformance runs yet")
      .closest(".flex.items-center.justify-center");
    expect(emptyState).not.toBeNull();
    expect(emptyState!.className).not.toMatch(/100vh/);
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

    expect(screen.queryByText("Loading run history…")).toBeNull();
    expect(screen.getAllByTestId("conformance-history-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
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

    expect(await screen.findByText("No runs for Alpha yet.")).toBeDefined();
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

    expect(
      (await screen.findByTestId("conformance-history-no-match")).textContent,
    ).toBe("No runs match “zzz”.");
    expect(screen.queryByTestId("conformance-history-row")).toBeNull();
  });

  it("sorts by server name, each server's runs newest first", async () => {
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

    await choose("conformance-history-sort", "Server name");

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
    expect(screen.getByText("Loading run history…")).toBeDefined();
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
    await choose("conformance-history-sort", "Server name");

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
    expect(
      (await screen.findByTestId("conformance-history-no-match")).getAttribute(
        "role",
      ),
    ).toBe("status");

    await user.clear(screen.getByTestId("conformance-history-search"));
    await choose("conformance-history-server-filter", "Alpha");
    expect(
      (await screen.findByText("No runs for Alpha yet.")).getAttribute("role"),
    ).toBe("status");
  });
});
