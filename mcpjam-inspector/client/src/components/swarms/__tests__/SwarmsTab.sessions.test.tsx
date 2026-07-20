import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONTRACT (finding 4): the sessions-by-run view must call the backend query
 * `journeyRuns:listSessionsByJourneyRun` with the arg name `journeyRunId` (NOT
 * `runId`), and consume the REAL `JourneySessionDto` — whose identifier is `id`
 * (there is no `_id` / `personaLabel` / `messageCount`). A test that mocked the
 * query away wouldn't catch the wrong arg name (Convex would throw at runtime).
 * Here we intercept `usePaginatedQuery` and assert the actual (name, args) the
 * component dispatches, then assert the row's `id` is what the viewer opens.
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
  config: { sessionsPerHost: 2, maxTurns: 6 },
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
  status: "active",
  modelId: "anthropic/claude-haiku-4.5",
  startedAt: 1,
  lastActivityAt: 2,
  readiness: { status: "completed", verdict: "ready", issueCount: 0 },
};

// Capture every paginated-query dispatch so we can assert the session query's
// arg NAME is `journeyRunId`.
const paginatedCalls: Array<{ name: string; args: unknown }> = [];

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
  }: {
    threadId: string;
    sessionLink: string;
  }) => (
    <div data-testid="viewer" data-thread-id={threadId} data-link={sessionLink}>
      viewer
    </div>
  ),
}));
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useDbUserReady: () => true,
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stub the promote dialog (it owns its own Convex action wiring — covered by
// convert-swarm-session-dialog.test.tsx) but surface open/session so we can
// assert the promote affordance hands it the SELECTED row.
vi.mock("@/components/swarms/convert-swarm-session-dialog", () => ({
  ConvertSwarmSessionDialog: ({
    open,
    session,
  }: {
    open: boolean;
    session: { id: string } | null;
  }) => (
    <div
      data-testid="promote-dialog"
      data-open={String(open)}
      data-session-id={session?.id ?? ""}
    />
  ),
}));

import { SwarmsTab } from "../SwarmsTab";

beforeEach(() => {
  paginatedCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Progressive discovery: expand journey → open a specific run's sessions. */
async function expandJourneyAndOpenRunSessions(
  runAriaLabel = /view sessions for run completed/i,
) {
  fireEvent.click(await screen.findByRole("button", { name: /show runs/i }));
  fireEvent.click(await screen.findByRole("button", { name: runAriaLabel }));
}

async function selectFirstDoneCell() {
  const matrix = await screen.findByTestId("swarm-sessions-matrix");
  const doneCell = within(matrix).getAllByTestId("swarm-host-cell").find(
    (el) => el.getAttribute("data-outcome") === "succeeded",
  );
  expect(doneCell).toBeTruthy();
  fireEvent.click(doneCell!);
}

describe("SwarmsTab — sessions-by-run query contract", () => {
  it("queries listSessionsByJourneyRun with { journeyRunId } and opens the viewer on the row's `id`", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));

    await expandJourneyAndOpenRunSessions();

    // CONTRACT: the session query is dispatched with the arg name `journeyRunId`
    // (NOT `runId`) carrying the run's id.
    await waitFor(() => {
      const call = paginatedCalls.find(
        (c) => c.name === "journeyRuns:listSessionsByJourneyRun"
      );
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ journeyRunId: "run-1" });
      // The wrong (old) arg name must not be present.
      expect((call!.args as Record<string, unknown>).runId).toBeUndefined();
    });

    await selectFirstDoneCell();
    fireEvent.click(
      await screen.findByRole("button", { name: /open full session detail/i }),
    );

    // CONTRACT: the viewer + deep-link consume the row's `id` (thread-xyz).
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.getAttribute("data-thread-id")).toBe("thread-xyz");
    expect(viewer.getAttribute("data-link")).toContain("thread-xyz");
  });

  it("opens the promote dialog with the selected session row", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));
    await expandJourneyAndOpenRunSessions();

    // The dialog is mounted closed until a session is selected + promoted.
    const dialog = await screen.findByTestId("promote-dialog");
    expect(dialog.getAttribute("data-open")).toBe("false");

    await selectFirstDoneCell();
    fireEvent.click(
      await screen.findByRole("button", { name: /open full session detail/i }),
    );
    fireEvent.click(await screen.findByText("Promote to test case"));

    await waitFor(() => {
      expect(dialog.getAttribute("data-open")).toBe("true");
      expect(dialog.getAttribute("data-session-id")).toBe("thread-xyz");
    });
  });

  it("surfaces failed attempts that never persisted a session transcript", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));
    await expandJourneyAndOpenRunSessions(
      /view sessions for run partial/i,
    );

    const matrix = await screen.findByTestId("swarm-sessions-matrix");
    expect(within(matrix).getByText("Host Two")).toBeInTheDocument();
    // Host Two's unpersisted failures surface as Fail cells in the matrix.
    const failCells = within(matrix)
      .getAllByTestId("swarm-host-cell")
      .filter((el) => el.getAttribute("data-outcome") === "failed");
    expect(failCells.length).toBeGreaterThanOrEqual(2);
  });

  it("maps sticky chat-session 'active' to 'done' once the run completed", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));
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
});
