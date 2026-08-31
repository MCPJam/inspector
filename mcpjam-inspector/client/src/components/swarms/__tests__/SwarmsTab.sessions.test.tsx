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
        status: "Exhausted",
        loadMore: vi.fn(),
        isLoading: false,
      };
    }
    if (name === "journeyRuns:listSessionsByPersona") {
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
});

afterEach(() => {
  vi.clearAllMocks();
});

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

describe("SwarmsTab — top-level Journeys view", () => {
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
