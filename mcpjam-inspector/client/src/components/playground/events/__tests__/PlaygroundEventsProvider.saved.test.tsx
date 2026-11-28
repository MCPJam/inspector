import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedEventWatch } from "@/lib/apis/event-watches-api";
import type { UseEventsFeedOptions } from "@/components/events/use-events-feed";
import {
  PlaygroundEventsProvider,
  usePlaygroundEvents,
} from "../PlaygroundEventsProvider";
import { useEventAgentBridge } from "../event-agent-bridge";

/**
 * A signed-in user's connections are saved with their conversation and come
 * back after a reload (AE-14); a model switch doesn't pause them.
 */
const mocks = vi.hoisted(() => ({
  rows: [] as SavedEventWatch[],
  queries: [] as Array<[unknown, unknown]>,
  createWatch: vi.fn(),
  createLocal: vi.fn(),
  watermark: vi.fn(),
  feed: vi.fn(),
}));
vi.mock("@/hooks/useEventsEnabled", () => ({ useEventsEnabledState: () => true }));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    mocks.queries.push([ref, args]);
    return ref === "eventWatches:listForConversation" && args !== "skip"
      ? mocks.rows
      : undefined;
  },
  useMutation: (ref: unknown) =>
    ref === "eventWatches:create" ? mocks.createWatch : vi.fn(),
}));
vi.mock("@/lib/apis/event-watches-api", () => ({
  EVENT_WATCHES_API: {
    listForConversation: "eventWatches:listForConversation",
    create: "eventWatches:create",
    update: "eventWatches:update",
    remove: "eventWatches:remove",
    claimEvent: "eventWatches:claimEvent",
  },
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({
    servers: { flights: { connectionStatus: "connected" } },
  }),
}));
vi.mock("@/components/events/use-events-host", () => ({
  useEventsHost: () => ({
    choice: { id: null, name: "MCPJam", modes: ["poll"], missing: false },
  }),
}));
vi.mock("@/components/events/use-events-feed", () => ({
  useEventsFeed: (options: unknown) => {
    mocks.feed(options);
    return { entries: [], gaps: [], status: "live", error: null };
  },
}));
vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => false }));
vi.mock("@/lib/events-traffic", () => ({ logEventsFeedEntries: vi.fn() }));
vi.mock("@/lib/apis/mcp-events-api", () => ({
  EVENT_SUBSCRIPTIONS_API: { list: "list", create: "create" },
  createLocalEventSubscription: (...args: unknown[]) => mocks.createLocal(...args),
  fetchLocalEventsFeed: (...args: unknown[]) => mocks.watermark(...args),
  hostedSubscriptionRowToView: (row: unknown) => row,
}));

let runtime: NonNullable<ReturnType<typeof usePlaygroundEvents>> | null;
function Consumer() {
  runtime = usePlaygroundEvents();
  return null;
}
const tree = (
  <PlaygroundEventsProvider
    projectId="project"
    hostId={null}
    host={null}
    savedProjectId="convex-project"
  >
    <Consumer />
  </PlaygroundEventsProvider>
);
const watch = (overrides: Partial<SavedEventWatch> = {}): SavedEventWatch => ({
  _id: "watch-1",
  projectId: "convex-project",
  chatSessionId: "chat-1",
  hostId: null,
  locality: "local",
  subscriptionId: "sub-1",
  logicalId: "logical-1",
  serverName: "flights",
  eventName: "flight.delayed",
  instructions: "Rebook me",
  createdBy: "agent",
  enabled: true,
  afterSeq: 12,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});
const publish = (hasMessages = true) =>
  useEventAgentBridge.getState().set({
    scope: "chat-1:",
    conversationId: "chat-1",
    hasMessages,
    blockedReason: null,
    send: async () => true,
  });

beforeEach(() => {
  vi.clearAllMocks();
  runtime = null;
  mocks.rows = [watch()];
  mocks.queries = [];
  mocks.watermark.mockResolvedValue({ entries: [], nextAfter: 30 });
  mocks.createLocal.mockResolvedValue({
    id: "sub-2",
    logicalId: "logical-2",
    eventName: "flight.cancelled",
    mode: "poll",
    arguments: {},
    observedState: "active",
    desiredState: "active",
  });
  publish();
});

describe("saved Playground event connections", () => {
  it("loads the open conversation's saved connections and starts the feed for them", async () => {
    render(tree);
    await waitFor(() => expect(runtime?.bindings).toHaveLength(1));
    expect(runtime?.saving).toBe(true);
    expect(runtime?.bindings[0]).toMatchObject({
      id: "watch-1",
      saved: true,
      afterSeq: 12,
      enabled: true,
    });
    expect(mocks.queries).toContainEqual([
      "eventWatches:listForConversation",
      { projectId: "convex-project", chatSessionId: "chat-1" },
    ]);
    const options = mocks.feed.mock.lastCall![0] as UseEventsFeedOptions;
    expect(options.enabled).toBe(true);
    // Local journals replay from their start; only hosted feeds use it.
    expect(options.startAfter).toBeUndefined();
    expect(options.resetKey).toContain("chat-1");
  });

  it("keeps a saved connection running when only the model changes", async () => {
    render(tree);
    await waitFor(() => expect(runtime?.bindings).toHaveLength(1));
    // The published scope no longer carries the model, so a model switch
    // republishes the same scope.
    act(() => publish());
    expect(runtime?.bindings[0].enabled).toBe(true);
    expect(runtime?.bindings[0].notice).toBeUndefined();
  });

  it("refuses to connect an event in a conversation with no messages yet", async () => {
    act(() => publish(false));
    render(tree);
    await expect(
      runtime!.add(
        { serverName: "flights" },
        { name: "flight.cancelled", delivery: ["poll"] },
        { arguments: {}, mode: "poll" },
        "Tell me",
      ),
    ).rejects.toThrow("Send a message first");
    expect(mocks.createWatch).not.toHaveBeenCalled();
  });

  it("saves a new connection with its conversation, client and position", async () => {
    mocks.createWatch.mockImplementation(async (args: Record<string, unknown>) =>
      watch({
        _id: "watch-2",
        subscriptionId: "sub-2",
        logicalId: "logical-2",
        eventName: "flight.cancelled",
        afterSeq: 30,
        updatedAt: 9,
        ...(args.title ? { title: String(args.title) } : {}),
      }),
    );
    render(tree);
    await waitFor(() => expect(runtime?.bindings).toHaveLength(1));
    let added: Awaited<ReturnType<NonNullable<typeof runtime>["add"]>> | undefined;
    await act(async () => {
      added = await runtime!.add(
        { serverName: "flights" },
        { name: "flight.cancelled", delivery: ["poll"] },
        { arguments: {}, mode: "poll" },
        "Tell me",
      );
    });
    expect(mocks.createWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "convex-project",
        chatSessionId: "chat-1",
        hostId: null,
        locality: "local",
        subscriptionId: "sub-2",
        afterSeq: 30,
        createdBy: "user",
      }),
    );
    expect(added).toMatchObject({ id: "watch-2", saved: true });
    expect(runtime?.liveBindings().map((binding) => binding.id)).toContain(
      "watch-2",
    );
  });
});
