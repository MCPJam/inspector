import { useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlaygroundEventsProvider,
  usePlaygroundEvents,
} from "../PlaygroundEventsProvider";
import { useEventAgentBridge } from "../event-agent-bridge";
import type { UseEventsFeedOptions } from "@/components/events/use-events-feed";

const mocks = vi.hoisted(() => ({
  flag: undefined as boolean | undefined,
  host: vi.fn(),
  create: vi.fn(),
  mutation: vi.fn(),
  feed: vi.fn(),
  watermark: vi.fn(),
  servers: { demo: { connectionStatus: "connected" } },
}));
vi.mock("@/hooks/useEventsEnabled", () => ({
  useEventsEnabledState: () => mocks.flag,
}));
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => mocks.mutation,
}));
vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({ servers: mocks.servers }),
}));
vi.mock("@/components/events/use-events-host", () => ({
  useEventsHost: (args: unknown) => {
    mocks.host(args);
    return {
      choice: { id: "host", name: "Client", modes: ["poll"], missing: false },
    };
  },
}));
vi.mock("@/components/events/use-events-feed", () => ({
  useEventsFeed: (options: unknown) => {
    mocks.feed(options);
    return { entries: [], status: "live", error: null };
  },
}));
vi.mock("@/lib/apis/mode-client", () => ({ isHostedMode: () => false }));
vi.mock("@/lib/events-traffic", () => ({ logEventsFeedEntries: vi.fn() }));
vi.mock("@/lib/apis/mcp-events-api", () => ({
  EVENT_SUBSCRIPTIONS_API: { list: "list", create: "create" },
  createLocalEventSubscription: (...args: unknown[]) => mocks.create(...args),
  fetchLocalEventsFeed: (...args: unknown[]) => mocks.watermark(...args),
  hostedSubscriptionRowToView: (row: unknown) => row,
}));

let runtime: NonNullable<ReturnType<typeof usePlaygroundEvents>> | null;
let mounts = 0;
function Consumer() {
  runtime = usePlaygroundEvents();
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div>Conversation</div>;
}
const tree = (hostId = "default-host") => (
  <PlaygroundEventsProvider projectId="project" hostId={hostId} host={null}>
    <Consumer />
  </PlaygroundEventsProvider>
);
const add = async () => {
  if (!runtime) throw new Error("Events runtime missing");
  await runtime.add(
    { serverName: "demo" },
    { name: "demo.ping", delivery: ["poll"] },
    { arguments: {}, mode: "poll" },
    "Report the ping",
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mounts = 0;
  runtime = null;
  mocks.flag = true;
  mocks.watermark.mockResolvedValue({ entries: [], nextAfter: 42 });
  useEventAgentBridge
    .getState()
    .set({ scope: "chat:client", blockedReason: null, send: async () => true });
  mocks.create.mockResolvedValue({
    id: "shared-subscription",
    logicalId: "logical",
    eventName: "demo.ping",
    mode: "poll",
    arguments: {},
    observedState: "active",
    desiredState: "active",
  });
});

describe("Playground Events lifecycle", () => {
  it("stops dispatch as soon as a shared subscription is removed, before another frame", async () => {
    const send = vi.fn(async () => true);
    useEventAgentBridge
      .getState()
      .set({ scope: "chat:client", blockedReason: null, send });
    render(tree());
    await act(add);
    const options = mocks.feed.mock.lastCall![0] as UseEventsFeedOptions;
    act(() => {
      options.onSubscription?.({
        ...runtime!.bindings[0].subscription!,
        desiredState: "removed",
        observedState: "removing",
      });
      options.onNewEntries?.([
        {
          seq: 43,
          kind: "event",
          origin: "poll",
          namespace: "live",
          logicalSubscriptionId: "logical",
          name: "demo.ping",
          eventId: "late",
          receivedAt: 101,
          data: {},
        },
      ]);
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("records when an occurrence arrived and what became of it", async () => {
    render(tree());
    await act(add);
    const options = mocks.feed.mock.lastCall![0] as UseEventsFeedOptions;
    const receivedAt = new Date(2026, 10, 25, 9, 30, 34).getTime();
    act(() => {
      options.onNewEntries?.([
        {
          seq: 43,
          kind: "event",
          origin: "push",
          namespace: "live",
          logicalSubscriptionId: "logical",
          name: "demo.ping",
          eventId: "arrival",
          receivedAt,
          data: {},
        },
      ]);
    });
    await waitFor(() =>
      expect(runtime!.bindings[0].recentEvents).toEqual([
        {
          key: expect.any(String),
          receivedAt,
          origin: "push",
          outcome: { status: "sent", message: "Event sent to agent" },
        },
      ]),
    );
  });

  it("preserves the conversation across flag hydration and host selection", () => {
    mocks.flag = undefined;
    const { rerender } = render(tree());
    mocks.flag = true;
    rerender(tree());
    rerender(tree("other-host"));
    expect(mounts).toBe(1);
    expect(mocks.host).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeHostId: "other-host" }),
    );
  });
  it("disconnects foreground bindings on client change without deleting shared subscriptions", async () => {
    const { rerender, unmount } = render(tree());
    await act(add);
    expect(runtime?.bindings).toHaveLength(1);
    rerender(tree("other-host"));
    expect(runtime?.bindings).toHaveLength(0);
    unmount();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("pauses a page-memory connection on a conversation change, but not on a page restore", async () => {
    render(tree());
    await act(add);
    act(() =>
      useEventAgentBridge.getState().set({
        scope: "other-chat:client",
        blockedReason: null,
        send: async () => true,
      }),
    );
    await waitFor(() => expect(runtime?.bindings[0].enabled).toBe(false));
    await act(async () => {
      await runtime?.edit(runtime.bindings[0].id, { enabled: true });
    });
    expect(runtime?.bindings[0].enabled).toBe(true);
    // The feed picks up from its last entry after a restore, so nothing is lost.
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(runtime?.bindings[0].enabled).toBe(true);
  });
  it("keeps an edit of a connection that's on from skipping what's queued", async () => {
    render(tree());
    await act(add);
    mocks.watermark.mockResolvedValue({ entries: [], nextAfter: 99 });
    await act(async () => {
      await runtime?.edit(runtime.bindings[0].id, {
        enabled: true,
        instructions: "Report the ping twice",
      });
    });
    expect(runtime?.bindings[0]).toMatchObject({
      afterSeq: 42,
      instructions: "Report the ping twice",
    });
  });
  it("subscribes and reads the local feed in its project", async () => {
    render(tree());
    await act(add);
    expect(mocks.watermark).toHaveBeenCalledWith(0, "project");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project", serverId: "demo" }),
    );
  });
  it("rejects a duplicate binding instead of silently losing new instructions", async () => {
    render(tree());
    await act(add);
    await expect(add()).rejects.toThrow("Use Edit");
    expect(runtime?.bindings).toHaveLength(1);
    expect(runtime?.bindings[0].afterSeq).toBe(42);
  });
  it("adds test-only bindings without creating or reading a shared subscription", () => {
    render(tree());
    act(() =>
      runtime?.addTest(
        { serverName: "demo" },
        { name: "demo.ping", delivery: ["poll"] },
        "Report the ping",
      ),
    );
    expect(runtime?.bindings).toHaveLength(1);
    expect(runtime?.bindings[0].subscription).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.watermark).not.toHaveBeenCalled();
    expect(mocks.feed).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
  it("waits for the conversation to finish loading before attaching either kind of event", async () => {
    useEventAgentBridge.getState().set({
      scope: "chat:client",
      blockedReason: "Wait for the agent conversation to finish loading.",
      send: async () => true,
    });
    render(tree());
    await expect(add()).rejects.toThrow("finish loading");
    expect(() =>
      runtime?.addTest(
        { serverName: "demo" },
        { name: "demo.ping", delivery: ["poll"] },
        "Report the ping",
      ),
    ).toThrow("finish loading");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(runtime?.bindings).toHaveLength(0);
  });
  it("does not resume a binding into a conversation selected during the feed read", async () => {
    render(tree());
    await act(add);
    const id = runtime!.bindings[0].id;
    await act(async () => runtime?.edit(id, { enabled: false }));
    let release!: (value: { entries: never[]; nextAfter: number }) => void;
    mocks.watermark.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = runtime!.edit(id, { enabled: true });
    act(() =>
      useEventAgentBridge.getState().set({
        scope: "different-conversation",
        blockedReason: null,
        send: async () => true,
      }),
    );
    await act(async () => {
      release({ entries: [], nextAfter: 43 });
      await pending;
    });
    expect(runtime?.bindings[0].enabled).toBe(false);
    expect(runtime?.bindings[0].agentScope).toBe("chat:client");
  });
  it("does not create a subscription after the client changes during the feed read", async () => {
    const { rerender } = render(tree());
    let release!: (value: { entries: never[]; nextAfter: number }) => void;
    mocks.watermark.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = add();
    rerender(tree("other-host"));
    release({ entries: [], nextAfter: 43 });
    await expect(pending).rejects.toThrow("client changed");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(runtime?.bindings).toHaveLength(0);
  });
});
