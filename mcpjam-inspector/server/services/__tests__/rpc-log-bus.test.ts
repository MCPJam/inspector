import { describe, expect, it, vi } from "vitest";
import {
  isRpcMessageLogEvent,
  rpcLogBus,
  type RpcLogEvent,
} from "../rpc-log-bus";

function event(serverId: string, id: number): RpcLogEvent {
  return {
    serverId,
    direction: "send",
    timestamp: new Date().toISOString(),
    message: { jsonrpc: "2.0", id, method: "tools/call" },
  };
}

/** Narrows to a JSON-RPC frame before reading `message` off the bus union. */
function idOf(event: RpcLogEvent): number | undefined {
  if (!isRpcMessageLogEvent(event)) return undefined;
  return (event.message as { id: number }).id;
}

describe("rpcLogBus", () => {
  it("caps the per-server replay buffer on write (oldest evicted)", () => {
    const serverId = `cap-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 620; i++) rpcLogBus.publish(event(serverId, i));

    const all = rpcLogBus.getBuffer([serverId], -1);
    expect(all).toHaveLength(500);
    // Oldest entries were evicted; the newest survive.
    expect(idOf(all[0])).toBe(120);
    expect(idOf(all[all.length - 1])).toBe(619);
  });

  it("isolates a throwing subscriber: publish never throws and later subscribers still fire", () => {
    const serverId = `throw-test-${crypto.randomUUID()}`;
    const seen: RpcLogEvent[] = [];
    const stopThrowing = rpcLogBus.subscribe([serverId], () => {
      throw new Error("subscriber bug");
    });
    const stopHealthy = rpcLogBus.subscribe([serverId], (e) => seen.push(e));
    try {
      expect(() => rpcLogBus.publish(event(serverId, 1))).not.toThrow();
    } finally {
      stopThrowing();
      stopHealthy();
    }
    // The healthy subscriber (registered AFTER the throwing one) still got it.
    expect(seen).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const serverId = `unsub-test-${crypto.randomUUID()}`;
    const listener = vi.fn();
    const stop = rpcLogBus.subscribe([serverId], listener);
    stop();
    rpcLogBus.publish(event(serverId, 1));
    expect(listener).not.toHaveBeenCalled();
  });

  it("carries HTTP-exchange events alongside frames, distinguished by kind", () => {
    const serverId = `http-test-${crypto.randomUUID()}`;
    const seen: RpcLogEvent[] = [];
    const stop = rpcLogBus.subscribe([serverId], (e) => seen.push(e));
    try {
      rpcLogBus.publish(event(serverId, 1));
      rpcLogBus.publish({
        kind: "http",
        serverId,
        timestamp: new Date().toISOString(),
        exchange: {
          serverId,
          request: {
            method: "POST",
            url: "https://example.test/mcp",
            headers: { "mcp-method": "tools/call" },
          },
          response: { status: 200, statusText: "OK", headers: {} },
          durationMs: 3,
        },
      });
    } finally {
      stop();
    }

    expect(seen).toHaveLength(2);
    // The frame narrows to a message event; the exchange does not, so a
    // frame-only consumer (the hosted bridge) can skip it.
    expect(seen.filter(isRpcMessageLogEvent)).toHaveLength(1);
    expect(idOf(seen[1])).toBeUndefined();
  });

  // Regression: the Logs SSE seeds every new connection from the replay buffer,
  // so a panel remount / EventSource reconnect re-delivers recent events. The
  // browser store keys rows on this `eventId` to recognize a re-delivery;
  // without a stable id per published event those replays render as duplicates.
  it("stamps every published event with a stable eventId that survives replay", () => {
    const serverId = `id-test-${crypto.randomUUID()}`;
    const live: Array<{ eventId: string }> = [];
    const stop = rpcLogBus.subscribe([serverId], (e) => live.push(e));
    try {
      rpcLogBus.publish(event(serverId, 14));
      rpcLogBus.publish({
        kind: "http",
        serverId,
        timestamp: new Date().toISOString(),
        exchange: {
          serverId,
          request: {
            method: "POST",
            url: "https://example.test/mcp",
            headers: {},
          },
          response: { status: 200, statusText: "OK", headers: {} },
          durationMs: 22,
        },
      });
    } finally {
      stop();
    }

    expect(live.map((e) => e.eventId)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    // Distinct per PUBLISHED event — never per method or per JSON-RPC id.
    expect(new Set(live.map((e) => e.eventId)).size).toBe(2);

    // A reconnect replays the tail; the ids must match the ones already
    // delivered so the client can recognize them.
    const replayed = rpcLogBus.getBuffer([serverId], 2);
    expect(replayed.map((e) => e.eventId)).toEqual(live.map((e) => e.eventId));
  });

  it("gives two identical-looking frames distinct eventIds (retries stay separate rows)", () => {
    const serverId = `retry-test-${crypto.randomUUID()}`;
    const seen: Array<{ eventId: string }> = [];
    const stop = rpcLogBus.subscribe([serverId], (e) => seen.push(e));
    try {
      // Same method, same JSON-RPC id, same payload — two real sends.
      rpcLogBus.publish(event(serverId, 14));
      rpcLogBus.publish(event(serverId, 14));
    } finally {
      stop();
    }
    expect(new Set(seen.map((e) => e.eventId)).size).toBe(2);
  });
});
