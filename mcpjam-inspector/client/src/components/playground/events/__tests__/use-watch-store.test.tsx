import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedEventWatch } from "@/lib/apis/event-watches-api";
import { useWatchStore } from "../use-watch-store";

const mocks = vi.hoisted(() => ({
  rows: undefined as SavedEventWatch[] | undefined,
  queryArgs: [] as unknown[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  claim: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    mocks.queryArgs.push(args);
    return args === "skip" ? undefined : mocks.rows;
  },
  useMutation: (ref: { _name?: string } | string) => {
    const name = typeof ref === "string" ? ref : String(ref);
    if (name.includes("create")) return mocks.create;
    if (name.includes("update")) return mocks.update;
    if (name.includes("remove")) return mocks.remove;
    return mocks.claim;
  },
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

function row(overrides: Partial<SavedEventWatch> = {}): SavedEventWatch {
  return {
    _id: "watch-1",
    projectId: "project",
    chatSessionId: "chat-1",
    hostId: "host-1",
    locality: "hosted",
    subscriptionId: "sub-1",
    logicalId: "esub_1",
    serverName: "flights",
    eventName: "flight.delayed",
    subscribeJson: JSON.stringify({ arguments: { flight: "MJ204" }, mode: "webhook" }),
    instructions: "Rebook me",
    createdBy: "agent",
    enabled: true,
    afterSeq: 7,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const options = {
  projectId: "project",
  conversationId: "chat-1",
  hostId: "host-1",
  locality: "hosted" as const,
  agentScope: "chat-1:host-1",
  ownerScope: "project:host-1:true",
  describe: () => undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = undefined;
  mocks.queryArgs = [];
});

describe("saved event connections", () => {
  it("saves nothing without a Convex project, as for a guest", () => {
    const { result } = renderHook(() =>
      useWatchStore({ ...options, projectId: null }),
    );
    expect(result.current.saving).toBe(false);
    expect(result.current.loaded).toBe(true);
    expect(mocks.queryArgs.at(-1)).toBe("skip");
  });

  it("maps the open conversation's rows to bindings with their saved arguments", () => {
    mocks.rows = [row()];
    const { result } = renderHook(() => useWatchStore(options));
    expect(result.current.saving).toBe(true);
    expect(result.current.bindings).toEqual([
      expect.objectContaining({
        id: "watch-1",
        saved: true,
        agentScope: "chat-1:host-1",
        afterSeq: 7,
        savedArguments: { flight: "MJ204" },
        event: { name: "flight.delayed", delivery: [] },
      }),
    ]);
    expect(result.current.isSaved("watch-1")).toBe(true);
  });

  it("leaves out rows made as another client or in the other runtime", () => {
    mocks.rows = [
      row({ _id: "other-client", hostId: "host-2" }),
      row({ _id: "local", locality: "local" }),
      row({ _id: "mine" }),
    ];
    const { result } = renderHook(() => useWatchStore(options));
    expect(result.current.bindings.map((binding) => binding.id)).toEqual([
      "mine",
    ]);
  });

  it("shows a new connection before the query catches up", async () => {
    mocks.rows = [];
    mocks.create.mockResolvedValue(row({ _id: "watch-2", updatedAt: 5 }));
    const { result } = renderHook(() => useWatchStore(options));
    await act(async () => {
      const saved = await result.current.save(
        {
          subscription: {
            id: "sub-2",
            logicalId: "esub_2",
          } as Parameters<typeof result.current.save>[0]["subscription"],
          serverName: "flights",
          event: { name: "flight.delayed", delivery: ["webhook"] },
          value: { arguments: { flight: "MJ204" }, mode: "webhook" },
        },
        { instructions: "Rebook me", afterSeq: 3, createdBy: "agent" },
      );
      expect(saved).toMatchObject({
        id: "watch-2",
        event: { name: "flight.delayed", delivery: ["webhook"] },
      });
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        chatSessionId: "chat-1",
        hostId: "host-1",
        locality: "hosted",
        subscriptionId: "sub-2",
        subscribeJson: '{"arguments":{"flight":"MJ204"},"mode":"webhook"}',
        afterSeq: 3,
      }),
    );
    expect(result.current.bindings.map((binding) => binding.id)).toEqual([
      "watch-2",
    ]);
  });

  it("puts a connection back when deleting it fails", async () => {
    mocks.rows = [row()];
    mocks.remove.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useWatchStore(options));
    await act(async () => {
      await expect(result.current.remove("watch-1")).rejects.toThrow(
        "offline",
      );
    });
    expect(result.current.bindings).toHaveLength(1);
  });

  it("claims only saved connections", async () => {
    mocks.rows = [row()];
    mocks.claim.mockResolvedValue({ claimed: true, previousAfterSeq: 7 });
    const { result } = renderHook(() => useWatchStore(options));
    await expect(result.current.claim("page-memory", 9)).resolves.toBeNull();
    await expect(result.current.claim("watch-1", 9)).resolves.toEqual({
      claimed: true,
      previousAfterSeq: 7,
    });
    expect(mocks.claim).toHaveBeenCalledWith({ watchId: "watch-1", seq: 9 });
  });

  it("remembers when the conversation's connections loaded", () => {
    mocks.rows = [row()];
    const { result } = renderHook(() => useWatchStore(options));
    const binding = result.current.bindings[0];
    expect(result.current.loadedAt(binding)).toEqual(expect.any(Number));
    expect(
      result.current.loadedAt({ ...binding, saved: false }),
    ).toBeUndefined();
  });

  it("counts the time again each time the conversation is reopened", async () => {
    mocks.rows = [row()];
    const { result, rerender } = renderHook((props) => useWatchStore(props), {
      initialProps: options,
    });
    const first = result.current.loadedAt(result.current.bindings[0]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    rerender({ ...options, conversationId: "chat-2" });
    rerender(options);
    const second = result.current.loadedAt(result.current.bindings[0]);
    expect(second).toBeGreaterThan(first!);
  });

  it("keeps a page's runtime fields on a saved connection", () => {
    mocks.rows = [row()];
    const { result } = renderHook(() => useWatchStore(options));
    act(() =>
      result.current.patchLive("watch-1", () => ({ notice: "Reconnect it" })),
    );
    expect(result.current.bindings[0].notice).toBe("Reconnect it");
  });
});
