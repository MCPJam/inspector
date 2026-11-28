import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_AGENT_TOOL_NAMES } from "@/shared/event-agent-tools";
import type { EventsFeedEntryView } from "@/shared/events-api";
import type { UseEventsFeedOptions } from "@/components/events/use-events-feed";
import {
  PlaygroundEventsProvider,
  usePlaygroundEvents,
} from "../PlaygroundEventsProvider";
import { useEventAgentBridge } from "../event-agent-bridge";
import { createEventAgentToolExecutor } from "../event-agent-tools";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  catalog: vi.fn(),
  feed: vi.fn(),
  watermark: vi.fn(),
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
  useMutation: () => vi.fn(),
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({ servers: mocks.servers }),
}));
vi.mock("@/components/events/use-events-host", () => ({
  useEventsHost: () => ({
    choice: {
      id: null,
      name: "MCPJam (built-in)",
      modes: ["poll", "push", "webhook"],
      missing: false,
    },
  }),
}));
vi.mock("@/components/events/use-events-feed", () => ({
  useEventsFeed: (options: unknown) => {
    mocks.feed(options);
    return { entries: [], status: "polling", error: null };
  },
}));
vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => false }));
vi.mock("@/lib/events-traffic", () => ({ logEventsFeedEntries: vi.fn() }));
vi.mock("@/lib/apis/mcp-events-api", () => ({
  EVENT_SUBSCRIPTIONS_API: { list: "list", create: "create" },
  createLocalEventSubscription: (...args: unknown[]) => mocks.create(...args),
  fetchLocalEventsFeed: (...args: unknown[]) => mocks.watermark(...args),
  loadEventsCatalog: (...args: unknown[]) => mocks.catalog(...args),
  hostedSubscriptionRowToView: (row: unknown) => row,
}));

const flightEvent = {
  name: "flight.status_changed",
  description: "A flight was delayed or cancelled.",
  delivery: ["poll", "push", "webhook"],
  inputSchema: {
    type: "object",
    properties: { tripId: { type: "string" }, flightId: { type: "string" } },
    required: ["tripId", "flightId"],
  },
};
const BUSY =
  "Event skipped while the agent is busy. Trigger it again when the turn finishes.";

let runtime: ReturnType<typeof usePlaygroundEvents> = null;
function Consumer() {
  runtime = usePlaygroundEvents();
  return null;
}
const tree = (
  <PlaygroundEventsProvider projectId="project" hostId={null} host={null}>
    <Consumer />
  </PlaygroundEventsProvider>
);
const executor = createEventAgentToolExecutor(() => runtime);
const send = vi.fn(async () => true);
const trip = { tripId: "trip-1", flightId: "MJ204" };
const subscribeInput = {
  server: "flights",
  title: "Rebook MJ204 if delayed",
  prompt: "If it's cancelled or delayed 3+ hours, rebook the next flight.",
  triggers: [{ event: "flight.status_changed", params: trip }],
};
function agentState(blockedReason: string | null) {
  useEventAgentBridge
    .getState()
    .set({ scope: "chat:model:", blockedReason, send });
}
function feedEntry(seq: number): EventsFeedEntryView {
  return {
    seq,
    kind: "event",
    origin: "poll",
    namespace: "live",
    logicalSubscriptionId: "esub_flight",
    name: "flight.status_changed",
    eventId: `evt-${seq}`,
    receivedAt: seq,
    data: {
      tripId: "trip-1",
      flight: { status: "delayed", delayMinutes: 180 },
    },
  };
}
function deliver(entry: EventsFeedEntryView) {
  const options = mocks.feed.mock.lastCall![0] as UseEventsFeedOptions;
  return act(async () => {
    options.onNewEntries?.([entry]);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime = null;
  mocks.watermark.mockResolvedValue({ entries: [], nextAfter: 42 });
  mocks.catalog.mockResolvedValue({
    events: [flightEvent],
    support: { handshakeObserved: true, declared: true, listChanged: false },
  });
  mocks.create.mockResolvedValue({
    id: "esub_flight",
    serverId: "flights",
    eventName: "flight.status_changed",
    arguments: trip,
    mode: "poll",
    desiredState: "active",
    observedState: "active",
    generation: 1,
    consecutiveFailures: 0,
    locality: "local",
  });
});

describe("the agent's subscription is Connect event's subscription", () => {
  it("creates it through add() from inside the agent's own busy turn, and it wakes the same conversation", async () => {
    agentState(BUSY);
    render(tree);
    // Catalogs load on connect, so the turn can advertise the tools.
    await act(async () => {
      await Promise.resolve();
    });
    expect(executor.snapshot()).toEqual({
      servers: [{ name: "flights", events: ["flight.status_changed"] }],
    });

    let result!: Awaited<ReturnType<typeof executor.execute>>;
    await act(async () => {
      result = await executor.execute(
        EVENT_AGENT_TOOL_NAMES.subscribe,
        "call-1",
        subscribeInput,
      );
    });
    expect(result.isError).toBeUndefined();
    // The exact request Connect event sends for the built-in client, push first.
    expect(mocks.create).toHaveBeenCalledWith({
      projectId: "project",
      serverId: "flights",
      eventName: "flight.status_changed",
      arguments: trip,
      mode: "push",
      host: null,
    });
    expect(runtime?.bindings).toHaveLength(1);
    expect(runtime?.bindings[0]).toMatchObject({
      title: subscribeInput.title,
      createdBy: "agent",
      instructions: subscribeInput.prompt,
      agentScope: "chat:model:",
      enabled: true,
      afterSeq: 42,
    });
    expect(JSON.parse(result.content[0].text).subscription).toMatchObject({
      subscription_id: runtime?.bindings[0].id,
      status: "listening",
    });

    // The user's Connect event still waits for the turn to finish.
    await expect(
      runtime!.add(
        { serverName: "flights" },
        flightEvent,
        { arguments: { tripId: "trip-2", flightId: "MJ318" }, mode: "poll" },
        "Tell me",
      ),
    ).rejects.toThrow(BUSY);

    // The turn ends; a later event starts a new turn in this conversation.
    agentState(null);
    await deliver(feedEntry(43));
    expect(send).toHaveBeenCalledTimes(1);
    const text = (send.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("Received event: flight.status_changed");
    expect(text).toContain(subscribeInput.prompt);
  });

  it("pauses, resumes, moves and stops it through the pane's own operations", async () => {
    agentState(null);
    render(tree);
    await act(async () => {
      await executor.execute(
        EVENT_AGENT_TOOL_NAMES.subscribe,
        "call-2",
        subscribeInput,
      );
    });
    const id = runtime!.bindings[0].id;
    const update = (callId: string, input: Record<string, unknown>) =>
      act(async () => {
        await executor.execute(EVENT_AGENT_TOOL_NAMES.update, callId, {
          subscription_id: id,
          ...input,
        });
      });

    await update("call-3", { is_enabled: false });
    expect(runtime?.bindings[0].enabled).toBe(false);
    await deliver(feedEntry(44));
    expect(send).not.toHaveBeenCalled();

    mocks.watermark.mockResolvedValue({ entries: [], nextAfter: 50 });
    await update("call-4", { is_enabled: true });
    expect(runtime?.bindings[0]).toMatchObject({ enabled: true, afterSeq: 50 });

    // A new trip moves the same connection through the same create path.
    const newTrip = { tripId: "trip-2", flightId: "MJ318" };
    mocks.create.mockResolvedValueOnce({
      ...(await mocks.create.mock.results[0].value),
      id: "esub_trip2",
      arguments: newTrip,
    });
    await update("call-5", {
      triggers: [{ event: "flight.status_changed", params: newTrip }],
      prompt: "Watch trip 2 instead.",
    });
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ arguments: newTrip, mode: "push" }),
    );
    expect(runtime?.bindings).toHaveLength(1);
    expect(runtime?.bindings[0]).toMatchObject({
      id,
      subscriptionId: "esub_trip2",
      logicalId: "esub_trip2",
      instructions: "Watch trip 2 instead.",
      title: subscribeInput.title,
    });

    await act(async () => {
      await executor.execute(EVENT_AGENT_TOOL_NAMES.delete, "call-6", {
        subscription_id: id,
      });
    });
    expect(runtime?.bindings).toHaveLength(0);
    await deliver(feedEntry(51));
    expect(send).not.toHaveBeenCalled();
  });
});
