import { act, render } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_AGENT_TOOL_NAMES } from "@/shared/event-agent-tools";
import {
  PlaygroundEventsProvider,
  usePlaygroundEvents,
} from "../PlaygroundEventsProvider";
import { useEventAgentBridge } from "../event-agent-bridge";
import { createEventAgentToolExecutor } from "../event-agent-tools";

const REFUSAL =
  "flight.status_changed is already subscribed under MCPJam (built-in) with the same arguments. Remove that subscription in the Events tab, then subscribe again.";

const mocks = vi.hoisted(() => ({
  createHosted: vi.fn(),
  catalog: vi.fn(),
  servers: {
    flights: {
      connectionStatus: "connected",
      config: { url: new URL("https://flights.example.com/mcp") },
    },
  },
}));
vi.mock("@/hooks/useEventsEnabled", () => ({
  useEventsEnabledState: () => true,
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => mocks.createHosted,
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({ servers: mocks.servers }),
}));
// The chat's saved client, as the Playground now subscribes in hosted mode.
vi.mock("@/components/events/use-events-host", () => ({
  useEventsHost: () => ({
    choice: {
      id: "host_mcpjam",
      name: "My MCPJam client",
      modes: ["poll", "push", "webhook"],
      missing: false,
    },
  }),
}));
vi.mock("@/components/events/use-events-feed", () => ({
  useEventsFeed: () => ({ entries: [], status: "polling", error: null }),
}));
vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => true }));
vi.mock("@/lib/events-traffic", () => ({ logEventsFeedEntries: vi.fn() }));
vi.mock("@/lib/apis/mcp-events-api", () => ({
  EVENT_SUBSCRIPTIONS_API: { list: "list", create: "create" },
  loadEventsCatalog: (...args: unknown[]) => mocks.catalog(...args),
  resolveHostedEventsServerId: () => "server_flights",
  buildHostedEventDescriptor: async () => undefined,
  fetchEventsViewerToken: async () => ({ token: "t", url: "u" }),
  fetchHostedEventsFeed: async () => ({ entries: [], nextAfter: 0 }),
  hostedSubscriptionRowToView: (row: unknown) => row,
}));

const flightEvent = {
  name: "flight.status_changed",
  delivery: ["poll", "push", "webhook"],
  inputSchema: {
    type: "object",
    properties: { tripId: { type: "string" } },
    required: ["tripId"],
  },
};

let runtime: ReturnType<typeof usePlaygroundEvents> = null;
function Consumer() {
  runtime = usePlaygroundEvents();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime = null;
  mocks.catalog.mockResolvedValue({
    events: [flightEvent],
    support: { handshakeObserved: true, declared: true, listChanged: false },
  });
  useEventAgentBridge
    .getState()
    .set({ scope: "chat:model:", blockedReason: null, send: vi.fn() });
});

describe("a hosted subscription another client holds", () => {
  it("is made as the chat's client, and the agent reads the backend's refusal, not Convex's wrapper", async () => {
    const refused = new ConvexError({ code: "CONFLICT", message: REFUSAL });
    refused.message =
      "[CONVEX M(eventSubscriptions:create)] [Request ID: abc123] Server Error";
    mocks.createHosted.mockRejectedValue(refused);
    render(
      <PlaygroundEventsProvider
        projectId="project"
        hostId="host_mcpjam"
        host={null}
      >
        <Consumer />
      </PlaygroundEventsProvider>,
    );
    const executor = createEventAgentToolExecutor(() => runtime);
    let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
    await act(async () => {
      result = await executor.execute(
        EVENT_AGENT_TOOL_NAMES.subscribe,
        "call-1",
        {
          server: "flights",
          title: "Watch the trip",
          prompt: "Tell me when it changes.",
          triggers: [
            { event: "flight.status_changed", params: { tripId: "t1" } },
          ],
        },
      );
    });
    expect(mocks.createHosted).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host_mcpjam", mode: "poll" }),
    );
    expect(result?.isError).toBe(true);
    expect(JSON.parse(result!.content[0].text).error).toBe(REFUSAL);
  });
});
