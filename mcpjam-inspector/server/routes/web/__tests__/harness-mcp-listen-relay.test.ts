import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  cancelRelayedListen,
  relayListenStream,
  relayableFilter,
  relayedListenCount,
} from "../harness-mcp-listen-relay";

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
type Frame = Record<string, any> | ":keepalive";

/** Reads a listen stream frame by frame: SSE messages parsed, comments as `:keepalive`. */
function frames(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  return {
    async next(timeoutMs = 3_000): Promise<Frame | undefined> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const split = buffer.indexOf("\n\n");
        if (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (block.startsWith(":")) return ":keepalive";
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "));
          return data ? JSON.parse(data.slice(6)) : undefined;
        }
        if (done) return undefined;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("no frame in time");
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("no frame in time")), left),
          ),
        ]);
        if (chunk.done) done = true;
        else buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

/** A manager whose one client listens as told; `emit` delivers an upstream notification. */
function fakeManager(
  opening: "ack" | "legacy" | "fail" | "hang" = "ack",
  honored: Record<string, unknown> = { toolsListChanged: true },
) {
  const handlers = new Map<string, Set<(n: any) => void>>();
  let settle!: (cause: "local" | "graceful" | "remote") => void;
  const handle = {
    honoredFilter: honored,
    close: vi.fn(async () => settle("local")),
    closed: new Promise<"local" | "graceful" | "remote">((resolve) => {
      settle = resolve;
    }),
  };
  const listen = vi.fn(
    async (_filter: unknown, options?: { signal?: AbortSignal }) => {
      if (opening === "legacy")
        throw new Error(
          "subscriptions/listen requires a 2026-07-28-era connection (negotiated: 2025-11-25).",
        );
      if (opening === "fail") throw new Error("upstream refused");
      if (opening === "hang")
        return new Promise<never>((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        );
      return handle;
    },
  );
  const manager = {
    addNotificationHandler: vi.fn(
      (_server: string, method: string, handler: (n: any) => void) => {
        const set = handlers.get(method) ?? new Set();
        set.add(handler);
        handlers.set(method, set);
      },
    ),
    removeNotificationHandler: vi.fn(
      (_server: string, method: string, handler: (n: any) => void) => {
        handlers.get(method)?.delete(handler);
      },
    ),
    getManagedClient: () => ({ listen }),
    ensureManagedClient: vi.fn(async () => ({ listen })),
  };
  return {
    manager: manager as never,
    handle,
    listen,
    settle: (cause: "graceful" | "remote") => settle(cause),
    emit: (method: string, params: Record<string, unknown>) => {
      for (const handler of handlers.get(method) ?? [])
        handler({ method, params });
    },
    handlerCount: () =>
      [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

const listenParams = {
  notifications: { toolsListChanged: true, taskIds: ["t1"] },
};

function relay(
  fake: ReturnType<typeof fakeManager>,
  extra: Partial<Parameters<typeof relayListenStream>[0]> = {},
) {
  const onEnd = vi.fn();
  const stream = relayListenStream({
    id: 7,
    params: listenParams,
    serverId: "srv",
    manager: fake.manager,
    cancelKey: "lane|srv|7",
    maxMs: 60_000,
    onEnd,
    ...extra,
  });
  return { onEnd, read: frames(stream) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relayableFilter", () => {
  it("keeps the change types and resource URIs, and drops task ids", () => {
    expect(
      relayableFilter({
        notifications: {
          toolsListChanged: true,
          promptsListChanged: false,
          resourceSubscriptions: ["file:///a", 3],
          taskIds: ["t1"],
        },
      }),
    ).toEqual({ toolsListChanged: true, resourceSubscriptions: ["file:///a"] });
    expect(relayableFilter(undefined)).toEqual({});
  });
});

describe("relayListenStream", () => {
  it("acknowledges first, with the filter the upstream honors, under the harness's own id", async () => {
    const fake = fakeManager();
    const { read } = relay(fake);
    expect(await read.next()).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { [SUBSCRIPTION_ID]: 7 },
        notifications: { toolsListChanged: true },
      },
    });
    expect(fake.listen).toHaveBeenCalledWith(
      { toolsListChanged: true },
      expect.anything(),
    );
    await read.cancel();
  });

  it("forwards a change the upstream sends on its listen, restamped, and nothing unstamped", async () => {
    const fake = fakeManager();
    const { read } = relay(fake);
    await read.next();
    fake.emit("notifications/tools/list_changed", {});
    fake.emit("notifications/tools/list_changed", {
      _meta: { [SUBSCRIPTION_ID]: "listen:0" },
    });
    expect(await read.next()).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: { _meta: { [SUBSCRIPTION_ID]: 7 } },
    });
    await read.cancel();
  });

  it("closes the upstream listen when the harness closes the stream, once", async () => {
    const fake = fakeManager();
    const { read, onEnd } = relay(fake);
    await read.next();
    expect(relayedListenCount()).toBe(1);
    await read.cancel();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(fake.handle.close).toHaveBeenCalled();
    expect(fake.handlerCount()).toBe(0);
    expect(relayedListenCount()).toBe(0);
  });

  it("closes it for the harness's notifications/cancelled", async () => {
    const fake = fakeManager();
    const { read, onEnd } = relay(fake);
    await read.next();
    expect(cancelRelayedListen("lane|srv|7")).toBe(true);
    expect(await read.next()).toBeUndefined();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(fake.handle.close).toHaveBeenCalled();
    expect(cancelRelayedListen("lane|srv|7")).toBe(false);
  });

  it("ends with the empty result when the upstream ends the subscription", async () => {
    const fake = fakeManager();
    const { read, onEnd } = relay(fake);
    await read.next();
    fake.settle("graceful");
    expect(await read.next()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { _meta: { [SUBSCRIPTION_ID]: 7 }, resultType: "complete" },
    });
    expect(await read.next()).toBeUndefined();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
  });

  it("ends without a result when the upstream is lost, so the harness can listen again", async () => {
    const fake = fakeManager();
    const { read } = relay(fake);
    await read.next();
    fake.settle("remote");
    expect(await read.next()).toBeUndefined();
  });

  it("checks the turn live on every keep-alive and ends once it is refused", async () => {
    const fake = fakeManager();
    let authorized = true;
    const stillAuthorized = vi.fn(async () => authorized);
    const { read } = relay(fake, { keepaliveMs: 20, stillAuthorized });
    await read.next();
    expect(await read.next()).toBe(":keepalive");
    await vi.waitFor(() => expect(stillAuthorized).toHaveBeenCalled());
    authorized = false;
    let frame: Frame | undefined;
    do frame = await read.next();
    while (frame === ":keepalive");
    expect(frame).toMatchObject({ id: 7, result: {} });
    expect(fake.handle.close).toHaveBeenCalled();
  });

  it("honors nothing for an upstream on a 2025-era connection", async () => {
    const fake = fakeManager("legacy");
    const { read } = relay(fake);
    expect(await read.next()).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: {} },
    });
    await read.cancel();
  });

  it("answers a listen the upstream refused with an error", async () => {
    const fake = fakeManager("fail");
    const { read, onEnd } = relay(fake);
    expect(await read.next()).toMatchObject({ id: 7, error: { code: -32603 } });
    expect(await read.next()).toBeUndefined();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
  });

  it("stops opening upstream when the harness leaves before the acknowledgment", async () => {
    const fake = fakeManager("hang");
    const { read, onEnd } = relay(fake);
    await vi.waitFor(() => expect(fake.listen).toHaveBeenCalled());
    await read.cancel();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
  });
});

describe("relayListenStream against a real 2026-07-28 server", () => {
  async function listenFixture() {
    const handler = createMcpHandler(() => {
      const mcp = new McpServer(
        { name: "listen-fixture", version: "1" },
        { capabilities: { tools: { listChanged: true } } },
      );
      mcp.registerTool("echo", {}, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      return mcp;
    });
    const server = http.createServer(toNodeHandler(handler));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    return {
      url: `http://127.0.0.1:${address.port}/mcp`,
      handler,
      close: async () => {
        await handler.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it("delivers a real change notification, and the harness's cancel closes the upstream subscription", async () => {
    const served = await listenFixture();
    const manager = new MCPClientManager();
    try {
      await manager.connectToServer("fixture", {
        url: served.url,
        timeout: 5_000,
      });
      const onEnd = vi.fn();
      const read = frames(
        relayListenStream({
          id: "harness-listen-1",
          params: { notifications: { toolsListChanged: true } },
          serverId: "fixture",
          manager,
          cancelKey: "fixture|harness-listen-1",
          maxMs: 60_000,
          onEnd,
        }),
      );
      expect(await read.next()).toEqual({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          _meta: { [SUBSCRIPTION_ID]: "harness-listen-1" },
          notifications: { toolsListChanged: true },
        },
      });
      expect(served.handler.bus.listenerCount).toBe(1);

      served.handler.notify.toolsChanged();
      expect(await read.next()).toMatchObject({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: { _meta: { [SUBSCRIPTION_ID]: "harness-listen-1" } },
      });

      await read.cancel();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(served.handler.bus.listenerCount).toBe(0));
    } finally {
      await manager.disconnectAllServers();
      await served.close();
    }
  });

  it("waits for a connect still running when the listen arrives", async () => {
    const served = await listenFixture();
    // Built the way the proxy builds one: the connect is queued, not awaited.
    const manager = new MCPClientManager({
      fixture: { url: served.url, timeout: 5_000 },
    });
    try {
      const read = frames(
        relayListenStream({
          id: 9,
          params: { notifications: { toolsListChanged: true } },
          serverId: "fixture",
          manager,
          cancelKey: "fixture|9",
          maxMs: 60_000,
        }),
      );
      expect(await read.next()).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
        params: { notifications: { toolsListChanged: true } },
      });
      served.handler.notify.toolsChanged();
      expect(await read.next()).toMatchObject({
        method: "notifications/tools/list_changed",
      });
      await read.cancel();
    } finally {
      await manager.disconnectAllServers();
      await served.close();
    }
  });
});
