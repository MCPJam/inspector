import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  hostIds: ["host-1"],
  config: { sessionsPerHost: 2, maxTurns: 6 },
};
const host = { hostId: "host-1", name: "Host One" };

const run = {
  _id: "run-1",
  status: "completed",
  summary: { total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
  hostSummaries: [
    { hostId: "host-1", total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
  ],
  createdAt: 1,
};

// A real JourneySessionDto row — identifier is `id`.
const session = {
  id: "thread-xyz",
  chatSessionId: "synth_run-1_host-1_0",
  projectId: "proj-1",
  hostId: "host-1",
  personaRefId: "persona-1",
  status: "completed",
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
        return [host];
      case "journeys:getJourneyRollup":
        return { journeyRefId: "journey-1", runCount: 1, hosts: [] };
      default:
        return undefined;
    }
  },
  useMutation: () => vi.fn(),
  usePaginatedQuery: (name: string, args: unknown) => {
    paginatedCalls.push({ name, args });
    if (name === "journeyRuns:listJourneyRuns") {
      return {
        results: [run],
        status: "Exhausted",
        loadMore: vi.fn(),
        isLoading: false,
      };
    }
    if (name === "journeyRuns:listSessionsByJourneyRun") {
      return {
        results: [session],
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

describe("SwarmsTab — sessions-by-run query contract", () => {
  it("queries listSessionsByJourneyRun with { journeyRunId } and opens the viewer on the row's `id`", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));

    // Open the run's sessions.
    fireEvent.click(await screen.findByText("View sessions"));

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

    // The session row renders (its unique modelId is in the accessible name) —
    // click it to open the viewer.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /anthropic\/claude-haiku-4\.5/i,
      })
    );

    // CONTRACT: the viewer + deep-link consume the row's `id` (thread-xyz).
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.getAttribute("data-thread-id")).toBe("thread-xyz");
    expect(viewer.getAttribute("data-link")).toContain("thread-xyz");
  });

  it("opens the promote dialog with the selected session row", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));
    fireEvent.click(await screen.findByText("View sessions"));

    // The dialog is mounted closed until a session is selected + promoted.
    const dialog = await screen.findByTestId("promote-dialog");
    expect(dialog.getAttribute("data-open")).toBe("false");

    fireEvent.click(
      await screen.findByRole("button", {
        name: /anthropic\/claude-haiku-4\.5/i,
      })
    );
    fireEvent.click(await screen.findByText("Promote to test case"));

    await waitFor(() => {
      expect(dialog.getAttribute("data-open")).toBe("true");
      expect(dialog.getAttribute("data-session-id")).toBe("thread-xyz");
    });
  });
});
