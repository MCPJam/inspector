import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NewJourneyButton's Advanced → Judge section pulls the model catalog via
// useAvailableModels (AppStateProvider-coupled); these tests render SwarmsTab
// without providers, so stub it to an empty catalog.
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

/**
 * CONTRACT (finding 4): the sessions-by-run view must call the backend query
 * `journeyRuns:listSessionsByJourneyRun` with the arg name `journeyRunId` (NOT
 * `runId`), and consume the REAL `JourneySessionDto` — whose identifier is `id`
 * (not `_id`). A test that mocked the query away wouldn't catch the wrong arg
 * name (Convex would throw at runtime). Here we intercept `usePaginatedQuery`
 * and assert the actual (name, args) the component dispatches, then assert the
 * row's `id` is what the viewer opens.
 *
 * The top-level Journeys tab defaults to `journeyRuns:listSessionsByProject`
 * (`{ projectId }`) and narrows to `listSessionsByPersona` (`{ personaRefId }`)
 * when a persona filter is applied via the top bar — same `id`-keyed DTO.
 */

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};
const journey = {
  _id: "journey-1",
  personaRefId: "persona-1",
  goal: "Book a flight",
  hostIds: ["host-1", "host-2"],
  config: { sessionsPerTarget: 2, maxTurns: 6 },
};
const host = { hostId: "host-1", name: "Host One" };
const hostTwo = { hostId: "host-2", name: "Host Two" };

const run = {
  _id: "run-1",
  status: "completed",
  summary: { total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
  hostSummaries: [
    { hostId: "host-1", total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
  ],
  createdAt: 1,
};

/** Partial run: Host Two failed both attempts with no persisted chatSessions. */
const runWithMissingFailures = {
  _id: "run-fail",
  status: "partial",
  summary: { total: 4, succeeded: 2, failed: 2, rateLimited: 0 },
  hostSummaries: [
    { hostId: "host-1", total: 2, succeeded: 2, failed: 0, rateLimited: 0 },
    { hostId: "host-2", total: 2, succeeded: 0, failed: 2, rateLimited: 0 },
  ],
  createdAt: 2,
};

// A real JourneySessionDto row — identifier is `id`.
// `status: "active"` is the chat-session lifecycle (often sticks after the
// journey run finishes) — UI must not show it as "journey still happening".
const session = {
  id: "thread-xyz",
  chatSessionId: "synth_run-1_host-1_0",
  projectId: "proj-1",
  hostId: "host-1",
  personaRefId: "persona-1",
  journeyRunId: "run-1",
  journeyRefId: "journey-1",
  status: "active",
  modelId: "anthropic/claude-haiku-4.5",
  startedAt: 1,
  lastActivityAt: 2,
  messageCount: 4,
  firstMessagePreview: "hello",
  personaLabel: "Persona One",
  visitorDisplayName: "Persona One",
  synthetic: true,
  readiness: { status: "completed", verdict: "ready", issueCount: 0 },
};

// Capture every paginated-query dispatch so we can assert the session query's
// arg NAME is `journeyRunId`.
const paginatedCalls: Array<{ name: string; args: unknown }> = [];
let projectSessionsStatus: "CanLoadMore" | "LoadingMore" | "Exhausted" =
  "Exhausted";
const projectSessionsLoadMore = vi.fn();
let personaSessionsStatus: "CanLoadMore" | "LoadingMore" | "Exhausted" =
  "Exhausted";
const personaSessionsLoadMore = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [persona];
      case "journeys:listJourneysByPersona":
        return [journey];
      case "hosts:listHosts":
        return [host, hostTwo];
      case "journeys:getJourneyRollup":
        return { journeyRefId: "journey-1", runCount: 2, hosts: [] };
      default:
        return undefined;
    }
  },
  useMutation: () => vi.fn(),
  usePaginatedQuery: (name: string, args: unknown) => {
    paginatedCalls.push({ name, args });
    if (name === "journeyRuns:listJourneyRuns") {
      return {
        results: [runWithMissingFailures, run],
        status: "Exhausted",
        loadMore: vi.fn(),
        isLoading: false,
      };
    }
    if (name === "journeyRuns:listSessionsByJourneyRun") {
      const journeyRunId =
        args && typeof args === "object" && "journeyRunId" in args
          ? (args as { journeyRunId: string }).journeyRunId
          : null;
      // Partial run: only Host One persisted sessions; Host Two failures have
      // no chatSession rows. Completed run: single session fixture.
      const results =
        journeyRunId === "run-fail"
          ? [
              {
                ...session,
                chatSessionId: "synth_run-fail_host-1_0",
              },
              {
                ...session,
                id: "thread-abc",
                hostId: "host-1",
                chatSessionId: "synth_run-fail_host-1_1",
              },
            ]
          : [session];
      return {
        results,
        status: "Exhausted",
        loadMore: vi.fn(),
        isLoading: false,
      };
    }
    if (name === "journeyRuns:listSessionsByProject") {
      return {
        results: [
          session,
          {
            ...session,
            id: "thread-h2",
            hostId: "host-2",
            chatSessionId: "synth_run-1_host-2_0",
            firstMessagePreview: "hola",
          },
        ],
        status: projectSessionsStatus,
        loadMore: projectSessionsLoadMore,
        isLoading: false,
      };
    }
    if (name === "journeyRuns:listSessionsByPersona") {
      return {
        results: [session],
        status: personaSessionsStatus,
        loadMore: personaSessionsLoadMore,
        isLoading: false,
      };
    }
    return {
      results: [],
      status: "Exhausted",
      loadMore: vi.fn(),
      isLoading: false,
    };
  },
}));

// Stub the heavy session viewer but SURFACE the threadId it's opened with so we
// can assert the deep-link/viewer consumes the row's `id`.
vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: ({
    threadId,
    sessionLink,
    promote,
  }: {
    threadId: string;
    sessionLink: string;
    promote?: { projectId: string; canPromote: boolean };
  }) => (
    <div
      data-testid="viewer"
      data-thread-id={threadId}
      data-link={sessionLink}
      data-promote-project={promote?.projectId ?? ""}
      data-can-promote={promote ? String(promote.canPromote) : ""}
    >
      viewer
    </div>
  ),
}));
vi.mock("@/lib/scenario-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { openPersonasTab } from "./swarms-tab-test-helpers";

beforeEach(() => {
  paginatedCalls.length = 0;
  projectSessionsStatus = "Exhausted";
  projectSessionsLoadMore.mockReset();
  personaSessionsStatus = "Exhausted";
  personaSessionsLoadMore.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Progressive discovery: click Host One's matrix cell (opens the LATEST run,
 * which the fixtures make `run-fail`/partial), then — for the completed run —
 * pick it from the host cell's trend strip. The partial run is already the
 * latest, so the cell click alone opens it.
 */
async function expandJourneyAndOpenRunSessions(
  target: "completed" | "partial" = "completed"
) {
  fireEvent.click(
    await screen.findByRole("button", {
      name: /open runs for book a flight on host one/i,
    })
  );
  if (target === "completed") {
    fireEvent.click(
      await screen.findByRole("button", {
        name: /open run completed .* on host one/i,
      })
    );
  }
}

async function selectFirstDoneCell() {
  const matrix = await screen.findByTestId("swarm-sessions-matrix");
  const doneCell = within(matrix)
    .getAllByTestId("swarm-host-cell")
    .find((el) => el.getAttribute("data-outcome") === "succeeded");
  expect(doneCell).toBeTruthy();
  fireEvent.click(doneCell!);
}

function openSessionsTab() {
  fireEvent.click(
    within(screen.getByLabelText("Swarm view")).getByRole("button", {
      name: /^sessions$/i,
    })
  );
}

async function selectPersonaFilter(name: string) {
  const filter = await screen.findByTestId("swarms-sessions-persona-filter");
  fireEvent.click(filter);
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("SwarmsTab — sessions-by-run query contract", () => {
  it("queries listSessionsByJourneyRun with { journeyRunId } and opens the viewer on the row's `id`", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);

    await expandJourneyAndOpenRunSessions();

    // CONTRACT: the session query is dispatched with the arg name `journeyRunId`
    // (NOT `runId`) carrying the run's id. The cell click opens the latest run
    // (run-fail) first, then the run-picker switches to run-1, so assert the
    // most-recent dispatch.
    await waitFor(() => {
      const call = [...paginatedCalls]
        .reverse()
        .find((c) => c.name === "journeyRuns:listSessionsByJourneyRun");
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ journeyRunId: "run-1" });
      // The wrong (old) arg name must not be present.
      expect((call!.args as Record<string, unknown>).runId).toBeUndefined();
    });

    await selectFirstDoneCell();
    fireEvent.click(
      await screen.findByRole("button", { name: /open full session detail/i })
    );

    // CONTRACT: the viewer + deep-link consume the row's `id` (thread-xyz).
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.getAttribute("data-thread-id")).toBe("thread-xyz");
    expect(viewer.getAttribute("data-link")).toContain("thread-xyz");
  });

  it("hands the selected session's promote capability to the detail pane", async () => {
    // The affordance itself lives in ShareUsageThreadDetail (shared with User
    // Testing); SwarmsTab's remaining job is supplying the project scope and
    // the member-tier verdict the thread row can't carry.
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    await expandJourneyAndOpenRunSessions();

    await selectFirstDoneCell();
    fireEvent.click(
      await screen.findByRole("button", { name: /open full session detail/i })
    );

    await waitFor(() => {
      const viewer = screen.getByTestId("viewer");
      expect(viewer.getAttribute("data-thread-id")).toBe("thread-xyz");
      expect(viewer.getAttribute("data-promote-project")).toBe("proj-1");
      // Swarms is member-gated at the route, so being here is the check.
      expect(viewer.getAttribute("data-can-promote")).toBe("true");
    });
  });

  it("opens a specific run when its trend segment is clicked", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);

    // Host One's strip has one segment per run; clicking the completed (run-1)
    // segment must open THAT run, not the latest.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /open run completed .*on host one/i,
      })
    );

    await waitFor(() => {
      const call = [...paginatedCalls]
        .reverse()
        .find((c) => c.name === "journeyRuns:listSessionsByJourneyRun");
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ journeyRunId: "run-1" });
    });
  });

  it("surfaces failed attempts that never persisted a session transcript", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    await expandJourneyAndOpenRunSessions("partial");
    fireEvent.click(
      await screen.findByRole("button", {
        name: /open runs for book a flight on host two/i,
      })
    );

    const matrix = await screen.findByTestId("swarm-sessions-matrix");
    expect(within(matrix).getAllByText("Host Two").length).toBeGreaterThan(0);
    // Host Two's unpersisted failures surface as Fail chips.
    const failCells = within(matrix)
      .getAllByTestId("swarm-host-cell")
      .filter((el) => el.getAttribute("data-outcome") === "failed");
    expect(failCells.length).toBeGreaterThanOrEqual(2);
  });

  it("maps sticky chat-session 'active' to 'done' once the run completed", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    await expandJourneyAndOpenRunSessions();

    const matrix = await screen.findByTestId("swarm-sessions-matrix");
    // Completed run + session.status=active must not pulse as Running.
    const running = within(matrix)
      .getAllByTestId("swarm-host-cell")
      .filter((el) => el.getAttribute("data-outcome") === "running");
    expect(running).toHaveLength(0);
    const done = within(matrix)
      .getAllByTestId("swarm-host-cell")
      .filter((el) => el.getAttribute("data-outcome") === "succeeded");
    expect(done.length).toBeGreaterThan(0);
    expect(within(done[0]!).getByText("Done")).toBeInTheDocument();
  });

  it("shows playground-style Trace / Chat / Raw tabs in the live pane", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    fireEvent.click(screen.getAllByText("Persona One")[0]);
    await expandJourneyAndOpenRunSessions();
    await selectFirstDoneCell();

    const tabs = await screen.findByTestId("swarm-live-trace-view-tabs");
    expect(
      within(tabs).getByRole("button", { name: /^trace$/i })
    ).toBeInTheDocument();
    expect(
      within(tabs).getByRole("button", { name: /^chat$/i })
    ).toBeInTheDocument();
    expect(
      within(tabs).getByRole("button", { name: /^raw$/i })
    ).toBeInTheDocument();
    // Playground parity: no Tool Calls / Steps / App tabs on this surface.
    expect(
      within(tabs).queryByRole("button", { name: /tool calls/i })
    ).toBeNull();
  });
});

describe("SwarmsTab — top-level Journeys view", () => {
  it("pages the project feed a bounded number of times, then hands over Load more", async () => {
    // Auto-paging exists to resolve a deep link and to fill the run-scoped
    // view — not to drain an unbounded project history on tab open.
    projectSessionsStatus = "CanLoadMore";
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openSessionsTab();

    const panel = await screen.findByTestId("swarms-sessions-panel");
    await waitFor(() => {
      expect(projectSessionsLoadMore).toHaveBeenCalled();
    });

    const loadMore = await within(panel).findByTestId(
      "swarms-sessions-load-more"
    );
    // Auto-paging stopped on its own — the button only exists once it has.
    const autoCalls = projectSessionsLoadMore.mock.calls.length;
    fireEvent.click(loadMore);
    // Exactly one page per click. The click must not re-arm auto-paging and
    // drain the rest of the history the reader just took control of.
    expect(projectSessionsLoadMore.mock.calls.length).toBe(autoCalls + 1);
    await waitFor(() => {
      expect(
        within(panel).getByTestId("swarms-sessions-load-more")
      ).toBeInTheDocument();
    });
    expect(projectSessionsLoadMore.mock.calls.length).toBe(autoCalls + 1);
  });

  it("re-arms the auto-page budget when the persona filter swaps the feed", async () => {
    // The budget is per-feed. Spending it on the project feed must not strand
    // the persona feed — a different query, whose results start over — on its
    // first page.
    projectSessionsStatus = "CanLoadMore";
    personaSessionsStatus = "CanLoadMore";
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openSessionsTab();

    const panel = await screen.findByTestId("swarms-sessions-panel");
    // Drain the project feed's budget until it hands over the button.
    await within(panel).findByTestId("swarms-sessions-load-more");
    expect(personaSessionsLoadMore).not.toHaveBeenCalled();

    await selectPersonaFilter("Persona One");

    // The fresh feed pages on its own rather than waiting on a click.
    await waitFor(() => {
      expect(personaSessionsLoadMore).toHaveBeenCalled();
    });
  });

  it("defaults to listSessionsByProject and opens the viewer on `id`", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openSessionsTab();

    await waitFor(() => {
      const call = paginatedCalls.find(
        (c) => c.name === "journeyRuns:listSessionsByProject"
      );
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ projectId: "proj-1" });
    });

    const panel = await screen.findByTestId("swarms-sessions-panel");
    expect(
      within(panel).getByTestId("swarms-sessions-persona-filter")
    ).toHaveTextContent("All personas");

    // Select via preview text — name appears twice (title + persona badge).
    fireEvent.click(within(panel).getByText("hello"));

    const viewer = await screen.findByTestId("viewer");
    expect(viewer.getAttribute("data-thread-id")).toBe("thread-xyz");
    expect(viewer.getAttribute("data-link")).toContain("persona=persona-1");
    expect(viewer.getAttribute("data-link")).toContain("run=run-1");
    expect(viewer.getAttribute("data-link")).toContain("session=thread-xyz");
  });

  it("filters the visible list by client (host) without changing the query", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openSessionsTab();

    // Both hosts' sessions are listed before filtering.
    const panel = await screen.findByTestId("swarms-sessions-panel");
    expect(within(panel).getByText("hello")).toBeInTheDocument();
    expect(within(panel).getByText("hola")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("swarms-sessions-host-filter"));
    fireEvent.click(await screen.findByRole("option", { name: "Host Two" }));

    await waitFor(() => {
      expect(within(panel).queryByText("hello")).toBeNull();
      expect(within(panel).getByText("hola")).toBeInTheDocument();
    });

    // Client filtering is client-side: still the project-level query, no new
    // query name.
    expect(
      paginatedCalls.every(
        (c) =>
          c.name !== "journeyRuns:listSessionsByHost" &&
          c.name !== "journeyRuns:listSessionsByClient"
      )
    ).toBe(true);

    fireEvent.click(screen.getByTestId("swarms-sessions-host-filter"));
    fireEvent.click(await screen.findByRole("option", { name: "All clients" }));
    await waitFor(() => {
      expect(within(panel).getByText("hello")).toBeInTheDocument();
    });
  });

  it("narrows to listSessionsByPersona when a persona is selected, and clears back to all", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openPersonasTab();
    openSessionsTab();
    await selectPersonaFilter("Persona One");

    await waitFor(() => {
      const call = paginatedCalls.find(
        (c) => c.name === "journeyRuns:listSessionsByPersona"
      );
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ personaRefId: "persona-1" });
    });

    await selectPersonaFilter("All personas");

    await waitFor(() => {
      const filter = screen.getByTestId("swarms-sessions-persona-filter");
      expect(filter).toHaveTextContent("All personas");
      const projectCalls = paginatedCalls.filter(
        (c) => c.name === "journeyRuns:listSessionsByProject"
      );
      expect(projectCalls.length).toBeGreaterThan(0);
    });
  });
});
