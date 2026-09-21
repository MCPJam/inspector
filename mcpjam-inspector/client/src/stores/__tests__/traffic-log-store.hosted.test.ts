import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: vi.fn((url: string) => url),
}));

import {
  ingestHostedHttpLogs,
  ingestHostedRpcLogs,
  subscribeToRpcStream,
  useTrafficLogStore,
} from "../traffic-log-store";
import type {
  HostedHttpLogEvent,
  HostedRpcLogEvent,
} from "@/shared/hosted-rpc-log";

function hostedFrame(
  eventId: string | undefined,
  jsonRpcId: number,
): HostedRpcLogEvent {
  return {
    ...(eventId ? { eventId } : {}),
    serverId: "srv-1",
    serverName: "stateless",
    direction: "send",
    timestamp: "2026-08-02T00:00:00.000Z",
    message: { jsonrpc: "2.0", id: jsonRpcId, method: "tools/call" },
  };
}

function hostedExchange(
  eventId: string | undefined,
  ray: string,
): HostedHttpLogEvent {
  return {
    ...(eventId ? { eventId } : {}),
    serverId: "srv-1",
    serverName: "stateless",
    timestamp: "2026-08-02T00:00:00.000Z",
    exchange: {
      serverId: "srv-1",
      request: {
        method: "POST",
        url: "https://stateless.mcpjam.com/mcp",
        headers: {},
      },
      response: { status: 200, statusText: "OK", headers: { "cf-ray": ray } },
      durationMs: 22,
    },
  };
}

describe("traffic-log-store hosted ingest", () => {
  beforeEach(() => {
    useTrafficLogStore.getState().clear();
  });

  // Hosted twin of the local SSE replay regression: a collector can deliver the
  // same captured event as a stream part AND again in the response envelope
  // (a mid-turn stream-write failure drops the writer and falls back to the
  // envelope, which still carries what already streamed).
  it("re-ingesting the same batch keeps one row per event", () => {
    const frames = [hostedFrame("rpc:h:1", 14), hostedFrame("rpc:h:3", 14)];
    const exchanges = [hostedExchange("rpc:h:2", "a2504a801d1e99a0")];

    ingestHostedRpcLogs(frames);
    ingestHostedHttpLogs(exchanges);
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(3);

    // Envelope delivery repeats the already-streamed events.
    ingestHostedRpcLogs(frames);
    ingestHostedHttpLogs(exchanges);

    const items = useTrafficLogStore.getState().mcpServerItems;
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
  });

  // The key is the PHYSICAL event, never the method: a multi-round MRTR flow
  // sends several real `tools/call`s for one user action, and a retry repeats
  // even the JSON-RPC id. Every one of them has to keep its own row.
  it("keeps distinct physical exchanges as separate rows", () => {
    ingestHostedRpcLogs([
      hostedFrame("rpc:h:1", 14),
      hostedFrame("rpc:h:2", 14), // retry: same method AND same JSON-RPC id
      hostedFrame("rpc:h:3", 15), // next MRTR round
    ]);
    ingestHostedHttpLogs([
      hostedExchange("rpc:h:4", "ray-a"),
      hostedExchange("rpc:h:5", "ray-b"),
    ]);

    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(5);
  });

  it("appends events from a producer that sends no eventId", () => {
    // Version skew must degrade to today's behavior, never drop rows.
    ingestHostedRpcLogs([
      hostedFrame(undefined, 14),
      hostedFrame(undefined, 14),
    ]);
    ingestHostedHttpLogs([
      hostedExchange(undefined, "ray-a"),
      hostedExchange(undefined, "ray-a"),
    ]);

    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(4);
  });
});

describe("traffic-log-store hosted mode", () => {
  beforeEach(() => {
    useTrafficLogStore.getState().clear();
  });

  it("does not create the local rpc EventSource subscription in hosted mode", () => {
    const eventSourceSpy = vi.fn();
    const originalEventSource = globalThis.EventSource;
    Object.assign(globalThis, { EventSource: eventSourceSpy });

    try {
      const unsubscribe = subscribeToRpcStream();

      expect(eventSourceSpy).not.toHaveBeenCalled();
      expect(typeof unsubscribe).toBe("function");
    } finally {
      Object.assign(globalThis, { EventSource: originalEventSource });
    }
  });
});
