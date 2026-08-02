import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: vi.fn((url: string) => url),
}));

/**
 * Minimal EventSource stand-in. `emit` plays a `data:` frame the same way the
 * Logs SSE route does, so the store's `onmessage` runs for real.
 */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.last = this;
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const originalEventSource = globalThis.EventSource;

async function loadStore() {
  vi.resetModules();
  return import("../traffic-log-store");
}

function rpcFrame(eventId: string, jsonRpcId: number) {
  return {
    type: "rpc",
    eventId,
    serverId: "srv-1",
    direction: "send",
    timestamp: "2026-08-02T00:00:00.000Z",
    message: { jsonrpc: "2.0", id: jsonRpcId, method: "tools/call" },
  };
}

function httpExchange(eventId: string, ray: string) {
  return {
    type: "http",
    eventId,
    serverId: "srv-1",
    timestamp: "2026-08-02T00:00:00.000Z",
    exchange: {
      serverId: "srv-1",
      request: {
        method: "POST",
        url: "https://stateless.mcpjam.com/mcp",
        headers: {},
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "cf-ray": ray },
      },
      durationMs: 22,
    },
  };
}

describe("traffic-log-store rpc stream (local mode)", () => {
  beforeEach(() => {
    Object.assign(globalThis, { EventSource: FakeEventSource });
    FakeEventSource.last = null;
  });

  afterEach(() => {
    Object.assign(globalThis, { EventSource: originalEventSource });
  });

  // Regression: the SSE route seeds each new connection from the replay buffer,
  // so a panel remount re-delivers events the store already holds. Keyed on the
  // bus-assigned eventId, a re-delivery updates its row instead of appending one.
  it("does not duplicate a replayed event that was already ingested", async () => {
    const { subscribeToRpcStream, useTrafficLogStore } = await loadStore();
    useTrafficLogStore.getState().clear();

    const unsubscribe = subscribeToRpcStream();
    const source = FakeEventSource.last!;
    source.emit(rpcFrame("rpc:abc:1", 14));
    source.emit(httpExchange("rpc:abc:2", "a2504a801d1e99a0"));
    source.emit(rpcFrame("rpc:abc:3", 14));
    unsubscribe();

    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(3);

    // Panel remounts: a fresh connection replays the same tail.
    const unsubscribe2 = subscribeToRpcStream();
    const replaySource = FakeEventSource.last!;
    expect(replaySource).not.toBe(source);
    replaySource.emit(rpcFrame("rpc:abc:1", 14));
    replaySource.emit(httpExchange("rpc:abc:2", "a2504a801d1e99a0"));
    replaySource.emit(rpcFrame("rpc:abc:3", 14));
    unsubscribe2();

    const items = useTrafficLogStore.getState().mcpServerItems;
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
  });

  // The dedup key must be the physical event, never the method: a multi-round
  // MRTR flow (or a retry) sends several real `tools/call`s for one user action
  // and every one of them has to stay visible.
  it("keeps distinct physical exchanges as separate rows", async () => {
    const { subscribeToRpcStream, useTrafficLogStore } = await loadStore();
    useTrafficLogStore.getState().clear();

    const unsubscribe = subscribeToRpcStream();
    const source = FakeEventSource.last!;
    // Three genuine `tools/call` sends, distinct JSON-RPC ids and cf-rays.
    source.emit(rpcFrame("rpc:abc:1", 14));
    source.emit(rpcFrame("rpc:abc:2", 15));
    source.emit(rpcFrame("rpc:abc:3", 16));
    source.emit(httpExchange("rpc:abc:4", "ray-a"));
    source.emit(httpExchange("rpc:abc:5", "ray-b"));
    unsubscribe();

    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(5);
  });

  it("still records events from a server that sends no eventId", async () => {
    const { subscribeToRpcStream, useTrafficLogStore } = await loadStore();
    useTrafficLogStore.getState().clear();

    const unsubscribe = subscribeToRpcStream();
    const source = FakeEventSource.last!;
    const { eventId: _omitted, ...withoutId } = rpcFrame("rpc:abc:1", 14);
    source.emit(withoutId);
    source.emit(withoutId);
    unsubscribe();

    // No identity to dedup on — both are kept rather than silently dropped.
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(2);
  });
});
