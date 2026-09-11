import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useConvex: vi.fn() }));
vi.mock("@/components/ui/json-editor", () => ({ JsonEditor: () => null }));
vi.mock("@mcpjam/design-system/button", () => ({ Button: () => null }));
vi.mock("lucide-react", () => ({
  Database: () => null,
  Download: () => null,
  Loader2: () => null,
  RefreshCw: () => null,
}));

import { collectRunRawData } from "../run-raw-data";

describe("collectRunRawData", () => {
  it("captures scenario aggregates, generated insights, and session detail", async () => {
    const query = vi.fn(async (name: unknown) => {
      switch (name) {
        case "chatSessions:listByScenario":
          return [{ _id: "session-1", chatSessionId: "chat-1" }];
        case "scenarioWindowInsights:getWindowSignals":
          return { latestGroupId: "window-1" };
        case "chatSessions:getSession":
          return {
            _id: "session-1",
            chatSessionId: "chat-1",
            messagesBlobUrl: null,
          };
        case "chatSessions:getSessionTurnTraces":
          return [];
        case "chatSessions:getTopicMapSnapshot":
          return { snapshot: null };
        default:
          return null;
      }
    });

    const bundle = await collectRunRawData(
      { query },
      {
        kind: "scenario",
        scenarioId: "scenario-1",
        snapshot: { name: "Checkout test" },
      }
    );

    expect(bundle.scope).toBe("scenario");
    expect(bundle.scopeSnapshot).toEqual({ name: "Checkout test" });
    expect(bundle.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: "chatSessions:listByScenario",
          status: "ok",
        }),
        expect.objectContaining({
          query: "scenarioWindowInsights:getWindowInsights",
          args: {
            scenarioId: "scenario-1",
            windowGroupId: "window-1",
          },
        }),
        expect.objectContaining({
          query: "chatSessions:getSession",
          args: { sessionId: "session-1" },
        }),
        expect.objectContaining({
          query: "chatSessionChecks:getCheckRunsForSession",
          args: { chatSessionId: "session-1" },
        }),
        expect.objectContaining({
          query: "chatSessions:getSessionHistoricalHostConfig",
          args: { sessionId: "session-1" },
        }),
      ])
    );
  });

  it("paginates swarm sessions and keeps individual query failures visible", async () => {
    const query = vi.fn(
      async (name: unknown, args: unknown): Promise<unknown> => {
        if (name === "journeyRuns:listSessionsByJourneyRun") {
          const cursor = (
            args as { paginationOpts?: { cursor?: string | null } }
          ).paginationOpts?.cursor;
          return cursor
            ? {
                page: [{ id: "session-2", chatSessionId: "chat-2" }],
                isDone: true,
                continueCursor: null,
              }
            : {
                page: [{ id: "session-1", chatSessionId: "chat-1" }],
                isDone: false,
                continueCursor: "next",
              };
        }
        if (name === "chatSessions:getBrowserArtifacts") {
          throw new Error("browser artifacts unavailable");
        }
        if (name === "chatSessions:getSessionTurnTraces") return [];
        if (name === "chatSessions:getSwarmTopicMapSnapshot") {
          return { snapshot: null };
        }
        return null;
      }
    );

    const bundle = await collectRunRawData(queryClient(query), {
      kind: "swarm",
      projectId: "project-1",
      swarmRunGroupId: "wave-1",
      runIds: ["run-1"],
      snapshot: { title: "Wave one" },
    });

    const sessionList = bundle.queries.find(
      (capture) => capture.query === "journeyRuns:listSessionsByJourneyRun"
    );
    expect(sessionList).toMatchObject({
      status: "ok",
      data: {
        page: [
          { id: "session-1", chatSessionId: "chat-1" },
          { id: "session-2", chatSessionId: "chat-2" },
        ],
        pagesFetched: 2,
        isDone: true,
      },
    });
    expect(bundle.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query: "chatSessions:getBrowserArtifacts",
          status: "error",
          error: "browser artifacts unavailable",
        }),
      ])
    );
  });
});

function queryClient(
  query: (name: unknown, args: unknown) => Promise<unknown>
) {
  return { query };
}
