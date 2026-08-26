import { describe, expect, it, vi } from "vitest";
import {
  isRpcMessageLogEvent,
  rpcLogBus,
  type RpcLogEvent,
} from "../rpc-log-bus";
import { isTruncatedRpcPayload } from "../../../shared/rpc-log-truncation";

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

function messageOf(event: RpcLogEvent): unknown {
  return isRpcMessageLogEvent(event) ? event.message : undefined;
}

/** A frame carrying `chars` of result data — the base64-tool-result shape. */
function bulkyEvent(serverId: string, id: number, chars: number): RpcLogEvent {
  return {
    serverId,
    direction: "receive",
    timestamp: new Date().toISOString(),
    message: { jsonrpc: "2.0", id, result: { data: "A".repeat(chars) } },
  };
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

  // A count cap alone does not bound memory. One MCP tool answering with a
  // base64 image fills 500 slots with gigabytes, which is how the Electron main
  // process reached a full old space in INSPECTOR-ELECTRON-W3.
  it("replaces an oversized frame with a marker, in the buffer and the live delivery", () => {
    const serverId = `oversized-${crypto.randomUUID()}`;
    const seen: RpcLogEvent[] = [];
    const stop = rpcLogBus.subscribe([serverId], (e) => seen.push(e));
    try {
      rpcLogBus.publish(bulkyEvent(serverId, 1, 600_000));
    } finally {
      stop();
    }

    const [live] = seen;
    const [buffered] = rpcLogBus.getBuffer([serverId], -1);
    expect(isTruncatedRpcPayload(messageOf(live))).toBe(true);
    // The SAME payload both ways. The browser store upserts rows on `eventId`,
    // so a replay that disagreed with the live delivery would silently swap a
    // body the reader was already looking at for a marker.
    expect(messageOf(buffered)).toBe(messageOf(live));
  });

  // The envelope is what the Logs panel labels the row by. Dropping it with the
  // body would leave a row nobody can identify.
  it("keeps the JSON-RPC envelope when it drops an oversized body", () => {
    const serverId = `envelope-${crypto.randomUUID()}`;
    rpcLogBus.publish({
      serverId,
      direction: "send",
      timestamp: new Date().toISOString(),
      message: {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { data: "A".repeat(600_000) },
      },
    });

    const [buffered] = rpcLogBus.getBuffer([serverId], -1);
    expect(messageOf(buffered)).toEqual({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      // The key survives even though the body did not — `extractMethod` labels
      // a response by the PRESENCE of `result`/`error`.
      params: { _truncated: true },
      _truncated: true,
      limitBytes: 256 * 1024,
    });
  });

  it("keeps a truncated response labelled as a response", () => {
    const serverId = `response-label-${crypto.randomUUID()}`;
    rpcLogBus.publish(bulkyEvent(serverId, 9, 600_000));

    const [buffered] = rpcLogBus.getBuffer([serverId], -1);
    expect(messageOf(buffered)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { _truncated: true },
      _truncated: true,
      limitBytes: 256 * 1024,
    });
  });

  it("leaves a frame under the per-frame cap untouched", () => {
    const serverId = `under-cap-${crypto.randomUUID()}`;
    rpcLogBus.publish(bulkyEvent(serverId, 7, 1_000));

    const [buffered] = rpcLogBus.getBuffer([serverId], -1);
    expect(isTruncatedRpcPayload(messageOf(buffered))).toBe(false);
    expect(idOf(buffered)).toBe(7);
  });

  // The preserved envelope is one entry per own key, so a frame with thousands
  // of top-level keys could come back "truncated" and still be over the cap.
  // Callers size their storage on this ceiling; it has to hold for every shape.
  it("falls back to a bare marker when the preserved envelope is itself oversized", () => {
    const serverId = `wide-frame-${crypto.randomUUID()}`;
    const wide: Record<string, unknown> = { jsonrpc: "2.0", id: 1 };
    for (let i = 0; i < 5_000; i++) {
      wide[`field_${i}`] = "y".repeat(200);
    }

    rpcLogBus.publish({
      serverId,
      direction: "receive",
      timestamp: new Date().toISOString(),
      message: wide,
    });

    const [buffered] = rpcLogBus.getBuffer([serverId], -1);
    // Not the 5,000 preserved scalars — the whole point of the cap.
    expect(messageOf(buffered)).toEqual({
      _truncated: true,
      limitBytes: 256 * 1024,
    });
  });

  it("evicts on total retained bytes, not only on event count", () => {
    const serverId = `total-bytes-${crypto.randomUUID()}`;
    // 200 KB each: every frame is under the per-frame cap, and 100 frames is
    // far under the 500-event cap — but ~20 MB is well past the per-server one.
    for (let i = 0; i < 100; i++) {
      rpcLogBus.publish(bulkyEvent(serverId, i, 200_000));
    }

    const all = rpcLogBus.getBuffer([serverId], -1);
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThan(100);
    // Evicted, not truncated: each frame fit, the buffer just holds fewer.
    expect(all.every((e) => !isTruncatedRpcPayload(messageOf(e)))).toBe(true);
    // Oldest go first; the newest frame is the one a reader wants.
    expect(idOf(all[all.length - 1])).toBe(99);
  });

  it("forgetServer drops a disconnected server's retained frames", () => {
    const serverId = `forget-${crypto.randomUUID()}`;
    rpcLogBus.publish(event(serverId, 1));
    expect(rpcLogBus.getBuffer([serverId], -1)).toHaveLength(1);

    rpcLogBus.forgetServer(serverId);

    expect(rpcLogBus.getBuffer([serverId], -1)).toHaveLength(0);
  });

  // `stats()` is what makes "the replay buffer is the heap ramp" falsifiable in
  // production rather than merely plausible — see utils/process-vitals.ts.
  // Asserted as DELTAS: the bus is a module singleton and every test in this
  // file publishes into it.
  it("reports retained bytes, events and servers", () => {
    const serverId = `stats-${crypto.randomUUID()}`;
    const before = rpcLogBus.stats();

    rpcLogBus.publish(bulkyEvent(serverId, 1, 100_000));
    rpcLogBus.publish(bulkyEvent(serverId, 2, 100_000));

    const after = rpcLogBus.stats();
    expect(after.servers).toBe(before.servers + 1);
    expect(after.events).toBe(before.events + 2);
    expect(after.bytes).toBeGreaterThan(before.bytes + 190_000);
    expect(after.truncatedFrames).toBe(before.truncatedFrames);
  });

  it("counts how often the per-frame cap fires", () => {
    const serverId = `stats-truncated-${crypto.randomUUID()}`;
    const before = rpcLogBus.stats();

    rpcLogBus.publish(bulkyEvent(serverId, 1, 600_000));

    expect(rpcLogBus.stats().truncatedFrames).toBe(before.truncatedFrames + 1);
  });

  it("releases the accounted bytes when a server is forgotten", () => {
    const serverId = `stats-forget-${crypto.randomUUID()}`;
    const before = rpcLogBus.stats();

    rpcLogBus.publish(bulkyEvent(serverId, 1, 100_000));
    expect(rpcLogBus.stats().bytes).toBeGreaterThan(before.bytes);

    rpcLogBus.forgetServer(serverId);

    // Not just the map entry — the byte accounting has to come back too, or the
    // gauge reports a leak that is not there.
    expect(rpcLogBus.stats().bytes).toBe(before.bytes);
    expect(rpcLogBus.stats().servers).toBe(before.servers);
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
