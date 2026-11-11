import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openEntrypointInNewChat,
  useEntrypointInNewChat,
  waitForChatOwner,
  type ChatOwnerStore,
} from "../entry-inline-fallback";
import type { ThreadAppWorkspace } from "../ThreadAppPanel";

const log = vi.hoisted(() => vi.fn());
vi.mock("../extension-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extension-log")>()),
  logExtensionEvent: log,
}));

type State = ReturnType<ChatOwnerStore["getState"]>;
function fakeStore(initial: State) {
  let state = initial;
  const listeners = new Set<(state: State) => void>();
  return {
    getState: () => state,
    subscribe: (listener: (state: State) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Partial<State>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    },
    listeners,
  };
}
const owner = () => {
  const launch = vi.fn(async () => {});
  return { launch, workspace: { launch } as unknown as ThreadAppWorkspace };
};
const server = { serverId: "board-server", name: "Board" };
const declaration = {
  toolName: "board",
  title: "Board",
  kind: "global" as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  log.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("openEntrypointInNewChat", () => {
  it("starts a chat, waits for its owner, then opens the App there inline", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    const next = owner();
    const beginNewChat = vi.fn(async (isCurrent: () => boolean) => {
      expect(isCurrent()).toBe(true);
      return "chat-2";
    });
    const opening = openEntrypointInNewChat({
      store,
      server,
      declaration,
      beginNewChat,
    });
    await vi.advanceTimersByTimeAsync(0);
    // The provider shows the new chat, then publishes its owner.
    store.set({ currentChatId: "chat-2" });
    expect(next.launch).not.toHaveBeenCalled();
    store.set({ chats: { "chat-2": next.workspace } });
    await expect(opening).resolves.toBe("opened");
    expect(next.launch).toHaveBeenCalledExactlyOnceWith(
      server,
      declaration,
      undefined,
      false,
      "inline",
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        serverId: "board-server",
        label: "display-mode",
        level: "info",
        message:
          "Board doesn't support full screen, so it opened inline in a new chat.",
      }),
    );
    expect(store.listeners.size).toBe(0);
  });

  it("says to open it again when no chat could start", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    await expect(
      openEntrypointInNewChat({
        store,
        server,
        declaration,
        beginNewChat: async () => null,
      }),
    ).resolves.toBe("no-chat");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining(
          "Open it again from Apps after the reply finishes, or after you send or discard your draft.",
        ),
      }),
    );
  });

  it("gives up when another chat is shown first", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    const other = owner();
    const opening = openEntrypointInNewChat({
      store,
      server,
      declaration,
      beginNewChat: async () => "chat-2",
    });
    await vi.advanceTimersByTimeAsync(0);
    store.set({
      currentChatId: "chat-3",
      chats: { "chat-3": other.workspace },
    });
    await expect(opening).resolves.toBe("chat-changed");
    expect(other.launch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("another chat was opened first"),
      }),
    );
  });

  it("gives up when the person leaves the new chat before it opens", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    const next = owner();
    const opening = openEntrypointInNewChat({
      store,
      server,
      declaration,
      beginNewChat: async () => "chat-2",
    });
    await vi.advanceTimersByTimeAsync(0);
    store.set({ currentChatId: "chat-2", chats: { "chat-2": next.workspace } });
    store.set({ currentChatId: "chat-3" });
    await expect(opening).resolves.toBe("chat-changed");
    expect(next.launch).not.toHaveBeenCalled();
  });

  it("reports no chat when the new chat's owner never appears", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    const opening = openEntrypointInNewChat({
      store,
      server,
      declaration,
      beginNewChat: async () => "chat-2",
      ownerTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(opening).resolves.toBe("no-chat");
  });

  it("lets the new chat lapse once the person moved on", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    let isCurrent!: () => boolean;
    const opening = openEntrypointInNewChat({
      store,
      server,
      declaration,
      beginNewChat: async (current) => {
        isCurrent = current;
        store.set({ currentChatId: "chat-9" });
        return isCurrent() ? "chat-2" : null;
      },
    });
    await expect(opening).resolves.toBe("no-chat");
    expect(isCurrent()).toBe(false);
  });
});

describe("waitForChatOwner", () => {
  it("resolves with an owner that is already published", async () => {
    const next = owner();
    const store = fakeStore({
      currentChatId: "chat-2",
      chats: { "chat-2": next.workspace },
    });
    await expect(waitForChatOwner(store, "chat-2", 100)).resolves.toBe(
      next.workspace,
    );
    expect(store.listeners.size).toBe(0);
  });

  it("resolves null after its time limit", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    const waiting = waitForChatOwner(store, "chat-2", 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(waiting).resolves.toBeNull();
    expect(store.listeners.size).toBe(0);
  });
});

describe("useEntrypointInNewChat", () => {
  it("gives the global owner a handler only when the client opens these Apps inline", async () => {
    const store = fakeStore({ currentChatId: "chat-1", chats: {} });
    const ports = { current: { beginNewChat: vi.fn(async () => null) } };
    const { result, rerender } = renderHook(
      ({ setting }: { setting: "refuse" | "inline" | undefined }) =>
        useEntrypointInNewChat(store, setting, ports),
      { initialProps: { setting: "refuse" } },
    );
    expect(result.current).toBeUndefined();
    rerender({ setting: undefined });
    expect(result.current).toBeUndefined();
    rerender({ setting: "inline" });
    const handler = result.current!;
    rerender({ setting: "inline" });
    expect(result.current).toBe(handler);
    handler(server, declaration);
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.current.beginNewChat).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning" }),
    );
  });
});
