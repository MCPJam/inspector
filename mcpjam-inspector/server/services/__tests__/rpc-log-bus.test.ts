import { describe, expect, it, vi } from "vitest";
import { rpcLogBus, type RpcLogEvent } from "../rpc-log-bus";

function event(serverId: string, id: number): RpcLogEvent {
  return {
    serverId,
    direction: "send",
    timestamp: new Date().toISOString(),
    message: { jsonrpc: "2.0", id, method: "tools/call" },
  };
}

describe("rpcLogBus", () => {
  it("caps the per-server replay buffer on write (oldest evicted)", () => {
    const serverId = `cap-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 620; i++) rpcLogBus.publish(event(serverId, i));

    const all = rpcLogBus.getBuffer([serverId], -1);
    expect(all).toHaveLength(500);
    // Oldest entries were evicted; the newest survive.
    expect((all[0].message as { id: number }).id).toBe(120);
    expect((all[all.length - 1].message as { id: number }).id).toBe(619);
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
});
