import { describe, expect, it, vi } from "vitest";
import { RpcLogBus } from "../rpc-log-bus.js";

describe("RpcLogBus", () => {
  it("filters buffered events by session and server", () => {
    const bus = new RpcLogBus();

    bus.publish({
      sessionId: "session-a",
      serverId: "server-1",
      direction: "send",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { method: "a" },
    });
    bus.publish({
      sessionId: "session-b",
      serverId: "server-1",
      direction: "receive",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { method: "b" },
    });
    bus.publish({
      sessionId: "session-a",
      serverId: "server-2",
      direction: "receive",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { method: "c" },
    });

    const events = bus.getBuffer(
      { serverIds: ["server-1"], sessionId: "session-a" },
      10,
    );

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("session-a");
    expect(events[0].serverId).toBe("server-1");
  });

  it("does not emit events when server filter is empty", () => {
    const bus = new RpcLogBus();
    const listener = vi.fn();

    const unsubscribe = bus.subscribe(
      { serverIds: [], sessionId: "session-a" },
      listener,
    );
    bus.publish({
      sessionId: "session-a",
      serverId: "server-1",
      direction: "send",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { method: "a" },
    });
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });
});
