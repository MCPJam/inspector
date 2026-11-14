import { describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import { harnessAppTools, type AppToolStore } from "../app-tools";

const entry = {
  alias: "app_01234567",
  bridgeId: "generation",
  appName: "CAD",
  serverId: "server",
  parentToolCallId: "parent",
  rawName: "read_view",
  readOnly: true,
};
function setup(store: AppToolStore, signal?: AbortSignal) {
  const chunks: UIMessageChunk[] = [];
  const tools = harnessAppTools({
    entries: [entry],
    projectId: "project",
    chatSessionId: "chat",
    turnId: "turn",
    authHeader: "Bearer private",
    store,
    signal,
    writer: { write: (chunk) => chunks.push(chunk) },
  });
  const execute = tools[entry.alias].execute!;
  return {
    execute: () => execute({}, { toolCallId: "call", messages: [] }),
    chunks,
  };
}
describe("native app-tool projection", () => {
  it("binds the invocation and returns only model-visible content", async () => {
    const store = {
      create: vi.fn(async () => ({ id: "row", expiresAt: Date.now() + 1000 })),
      read: vi.fn(async () => ({
        state: "completed",
        resultJson: JSON.stringify({
          content: [{ type: "text", text: "public" }],
          _meta: { secret: true },
          structuredContent: { private: true },
        }),
      })),
      finish: vi.fn(async () => undefined),
    };
    const s = setup(store);
    expect(await s.execute()).toEqual({
      content: [{ type: "text", text: "public" }],
    });
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        chatSessionId: "chat",
        turnId: "turn",
        toolCallId: "call",
        bridgeId: "generation",
        alias: entry.alias,
      }),
    );
    expect(s.chunks).toEqual([
      {
        type: "data-harness-app-tool",
        transient: true,
        data: expect.objectContaining({
          id: "row",
          chatSessionId: "chat",
          bridgeId: "generation",
        }),
      },
    ]);
    expect(store.finish).toHaveBeenCalledWith("row", true);
  });
  it("does not redispatch an unknown outcome and retains cleanup on failure", async () => {
    const store = {
      create: vi.fn(async () => ({ id: "row", expiresAt: Date.now() + 1000 })),
      read: vi.fn(async () => ({ state: "unknown" })),
      finish: vi.fn(async () => undefined),
    };
    expect(await setup(store).execute()).toMatchObject({ isError: true });
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.finish).toHaveBeenCalledWith("row", false);
  });
  it("stops a hung create on abort and cleans up a late receipt", async () => {
    const abort = new AbortController();
    let resolveCreate!: (row: { id: string; expiresAt: number }) => void;
    const store = {
      create: vi.fn(
        () =>
          new Promise<{ id: string; expiresAt: number }>((resolve) => {
            resolveCreate = resolve;
          }),
      ),
      read: vi.fn(async () => ({ state: "pending" })),
      finish: vi.fn(async () => undefined),
    };
    const pending = setup(store, abort.signal).execute();
    await vi.waitFor(() => expect(store.create).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(await pending).toMatchObject({ isError: true });
    resolveCreate({ id: "late", expiresAt: Date.now() + 1000 });
    await vi.waitFor(() =>
      expect(store.finish).toHaveBeenCalledWith("late", false),
    );
    expect(store.read).not.toHaveBeenCalled();
  });
  it("bounds a hung result read by the receipt deadline", async () => {
    vi.useFakeTimers();
    try {
      const store = {
        create: vi.fn(async () => ({
          id: "row",
          expiresAt: Date.now() + 1000,
        })),
        read: vi.fn(() => new Promise<{ state: string }>(() => {})),
        finish: vi.fn(async () => undefined),
      };
      const pending = setup(store).execute();
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toMatchObject({ isError: true });
      expect(store.finish).toHaveBeenCalledWith("row", false);
    } finally {
      vi.useRealTimers();
    }
  });
});
