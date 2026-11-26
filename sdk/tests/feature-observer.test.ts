import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createFeatureFrameTap,
  isFeatureObservationPaused,
  pauseFeatureObservation,
  suppressFeatureObservation,
  type FeatureObservationEvent,
} from "../src/mcp-client-manager/feature-observer.js";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { wrapTransportForLogging } from "../src/mcp-client-manager/transport-utils.js";
import {
  createFixtureHandler,
  FIXTURE_GREETING_URI,
} from "./support/dual-era-fixture.js";

function frame(value: Record<string, unknown>): JSONRPCMessage {
  return { jsonrpc: "2.0", ...value } as JSONRPCMessage;
}

function collect() {
  const events: FeatureObservationEvent[] = [];
  return {
    events,
    observer: (event: FeatureObservationEvent) => events.push(event),
  };
}

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];
  async start() {}
  async send(message: JSONRPCMessage) {
    this.sent.push(message);
  }
  async close() {}
  deliver(message: JSONRPCMessage) {
    this.onmessage?.(message);
  }
}

describe("createFeatureFrameTap", () => {
  it("classifies a response by the method of the request it answers", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer, { now: () => 42 });
    tap.observe(
      "send",
      frame({ id: 1, method: "resources/read", params: { uri: "file:///x" } })
    );
    expect(events).toEqual([]);
    tap.observe("receive", frame({ id: 1, result: { contents: [] } }));
    expect(events).toEqual([
      { serverId: "srv", featureIds: ["resources.read"], at: 42 },
    ]);
    // The request is consumed: a duplicate response classifies as nothing.
    tap.observe("receive", frame({ id: 1, result: { contents: [] } }));
    expect(events).toHaveLength(1);
  });

  it("hands the observer ids only, never the frame", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.observe("send", frame({ id: "a", method: "tools/call" }));
    tap.observe(
      "receive",
      frame({
        id: "a",
        result: { content: [{ type: "text", text: "secret text" }] },
      })
    );
    expect(Object.keys(events[0]).sort()).toEqual([
      "at",
      "featureIds",
      "serverId",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret text");
  });

  it("reads the era from the negotiated protocol version", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    const listChanged = frame({ method: "notifications/tools/list_changed" });
    tap.observe("receive", listChanged);
    tap.setProtocolVersion("2026-07-28");
    tap.observe("receive", listChanged);
    expect(events.map((event) => event.featureIds)).toEqual([
      ["tools.list-changed"],
      ["tools.list-changed", "subscriptions.list-changed-on-stream"],
    ]);
  });

  it("keeps string and numeric request ids apart", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.observe("send", frame({ id: 1, method: "ping" }));
    tap.observe("receive", frame({ id: "1", result: {} }));
    expect(events).toEqual([]);
  });

  it("forgets the oldest request past its bound", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer, { maxPending: 2 });
    for (const id of [1, 2, 3])
      tap.observe("send", frame({ id, method: "resources/read" }));
    tap.observe("receive", frame({ id: 1, result: { contents: [] } }));
    expect(events).toEqual([]);
    tap.observe("receive", frame({ id: 3, result: { contents: [] } }));
    expect(events).toHaveLength(1);
  });

  it("resolves a server cancellation to the request it ends", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.setProtocolVersion("2026-07-28");
    tap.observe("send", frame({ id: 9, method: "subscriptions/listen" }));
    tap.observe(
      "receive",
      frame({ method: "notifications/cancelled", params: { requestId: 9 } })
    );
    // On 2026-07-28 this is the stream ending, not a request cancellation.
    expect(events[0].featureIds).toEqual(["subscriptions.stream-end"]);
  });

  it("resolves a server's cancellation to its own request before the client's", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.observe("send", frame({ id: 5, method: "tools/call" }));
    tap.observe("receive", frame({ id: 5, method: "elicitation/create" }));
    tap.observe(
      "receive",
      frame({ method: "notifications/cancelled", params: { requestId: 5 } })
    );
    // The client's tools/call with the same id is still pending.
    tap.observe(
      "receive",
      frame({ id: 5, result: { content: [], isError: true } })
    );
    expect(events.map((event) => event.featureIds)).toEqual([
      ["client.elicitation-form"],
      ["request-control.cancellation"],
      ["tool-results.content", "tool-results.is-error"],
    ]);
  });

  it("reports no stream end when the server cancels its own request with a listen's id", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.setProtocolVersion("2026-07-28");
    tap.observe("send", frame({ id: 3, method: "subscriptions/listen" }));
    tap.observe("receive", frame({ id: 3, method: "elicitation/create" }));
    tap.observe(
      "receive",
      frame({ method: "notifications/cancelled", params: { requestId: 3 } })
    );
    // Resolved to the server's own elicitation, so no stream end; and
    // 2026-07-28 forbids that cancellation, so nothing else counts either.
    expect(events.map((event) => event.featureIds)).toEqual([
      ["client.elicitation-form"],
    ]);
  });

  it("forgets a request the client cancels itself", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.observe("send", frame({ id: 4, method: "resources/read" }));
    tap.observe(
      "send",
      frame({ method: "notifications/cancelled", params: { requestId: 4 } })
    );
    // A late answer to the cancelled read has no request left to classify by.
    tap.observe("receive", frame({ id: 4, result: { contents: [] } }));
    expect(events).toEqual([]);
  });

  it("classifies each frame of a batch", () => {
    const { events, observer } = collect();
    const tap = createFeatureFrameTap("srv", observer);
    tap.observe("receive", [
      { jsonrpc: "2.0", method: "notifications/progress", params: {} },
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
    ]);
    expect(events.map((event) => event.featureIds)).toEqual([
      ["request-control.progress"],
      ["request-control.log-messages"],
    ]);
  });
});

describe("wrapTransportForLogging with a feature observer", () => {
  it("observes both directions and passes frames through unchanged", async () => {
    const { events, observer } = collect();
    const inner = new FakeTransport();
    const wrapped = wrapTransportForLogging(
      "srv",
      () => {},
      inner,
      createFeatureFrameTap("srv", observer)
    );
    const delivered: JSONRPCMessage[] = [];
    wrapped.onmessage = (message) => delivered.push(message);
    wrapped.setProtocolVersion?.("2025-11-25");

    const call = frame({ id: 1, method: "tools/call", params: { name: "x" } });
    await wrapped.send(call);
    const reply = frame({ id: 1, result: { content: [], isError: true } });
    inner.deliver(reply);

    expect(inner.sent).toEqual([call]);
    expect(delivered[0]).toBe(reply);
    expect(events.map((event) => event.featureIds)).toEqual([
      ["tool-results.content", "tool-results.is-error"],
    ]);
  });

  it("never lets an observer failure reach the transport", async () => {
    const inner = new FakeTransport();
    const observer = vi.fn(() => {
      throw new Error("observer broke");
    });
    const wrapped = wrapTransportForLogging(
      "srv",
      () => {},
      inner,
      createFeatureFrameTap("srv", observer)
    );
    const delivered: JSONRPCMessage[] = [];
    wrapped.onmessage = (message) => delivered.push(message);

    await expect(
      wrapped.send(frame({ id: 1, method: "ping" }))
    ).resolves.toBeUndefined();
    inner.deliver(frame({ id: 1, result: {} }));

    expect(observer).toHaveBeenCalledTimes(1);
    expect(inner.sent).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it("classifies nothing without a tap", async () => {
    const inner = new FakeTransport();
    const logger = vi.fn();
    const wrapped = wrapTransportForLogging("srv", logger, inner);
    await wrapped.send(frame({ id: 1, method: "ping" }));
    inner.deliver(frame({ id: 1, result: {} }));
    expect(logger).toHaveBeenCalledTimes(2);
  });
});

describe("pausing feature observation", () => {
  const read = (id: number) =>
    frame({ id, method: "resources/read", params: { uri: "file:///x" } });
  const readResult = (id: number) => frame({ id, result: { contents: [] } });

  it("drops frames while paused and whatever answers a paused request", () => {
    const { events, observer } = collect();
    let paused = true;
    const tap = createFeatureFrameTap("srv", observer, {
      isPaused: () => paused,
    });
    tap.observe("send", read(1));
    tap.observe("receive", frame({ method: "notifications/message" }));
    paused = false;
    // Its request was sent while paused, so its late answer is ours too.
    tap.observe("receive", readResult(1));
    expect(events).toEqual([]);

    tap.observe("send", read(2));
    tap.observe("receive", readResult(2));
    expect(events.map((event) => event.featureIds)).toEqual([
      ["resources.read"],
    ]);
  });

  it("drops a server's cancellation of a paused request", () => {
    const { events, observer } = collect();
    let paused = true;
    const tap = createFeatureFrameTap("srv", observer, {
      isPaused: () => paused,
    });
    tap.setProtocolVersion("2026-07-28");
    tap.observe("send", frame({ id: 7, method: "subscriptions/listen" }));
    tap.observe("receive", frame({ id: 8, method: "elicitation/create" }));
    paused = false;
    // The stdio end of the paused listen stream, then the server cancelling
    // its own request sent while paused.
    tap.observe(
      "receive",
      frame({ method: "notifications/cancelled", params: { requestId: 7 } })
    );
    tap.observe(
      "receive",
      frame({ method: "notifications/cancelled", params: { requestId: 8 } })
    );
    expect(events).toEqual([]);
  });

  it("nests pauses, and a second resume does nothing", () => {
    const manager = new MCPClientManager();
    const first = pauseFeatureObservation(manager, "srv");
    const second = pauseFeatureObservation(manager, "srv");
    first();
    first();
    expect(isFeatureObservationPaused(manager, "srv")).toBe(true);
    expect(isFeatureObservationPaused(manager, "other")).toBe(false);
    expect(isFeatureObservationPaused(new MCPClientManager(), "srv")).toBe(
      false
    );
    second();
    expect(isFeatureObservationPaused(manager, "srv")).toBe(false);
  });

  it("resumes once the suppressed work settles, even when it fails", async () => {
    const manager = new MCPClientManager();
    const work = suppressFeatureObservation(manager, "srv", async () => {
      expect(isFeatureObservationPaused(manager, "srv")).toBe(true);
      throw new Error("work failed");
    });
    await expect(work).rejects.toThrow("work failed");
    expect(isFeatureObservationPaused(manager, "srv")).toBe(false);
  });
});

describe("MCPClientManager keeps its own traffic out of observation", () => {
  let httpServer: http.Server | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await new Promise<void>((resolve) =>
      httpServer ? httpServer.close(() => resolve()) : resolve()
    );
    httpServer = undefined;
    manager = undefined;
  });

  async function serveFixture(): Promise<string> {
    const server = http.createServer(
      toNodeHandler(createFixtureHandler({ logging: true }))
    );
    httpServer = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  it("observes neither the handshake nor its automatic logging/setLevel", async () => {
    const url = await serveFixture();
    const { events, observer } = collect();
    const setLevelIds = new Set<unknown>();
    let setLevelAnswered = false;
    const connected = new MCPClientManager(
      {},
      {
        featureObserver: observer,
        rpcLogger: ({ direction, message }) => {
          const rpc = message as { id?: unknown; method?: unknown };
          if (direction === "send" && rpc.method === "logging/setLevel")
            setLevelIds.add(rpc.id);
          if (direction === "receive" && setLevelIds.has(rpc.id))
            setLevelAnswered = true;
        },
      }
    );
    manager = connected;
    await connected.connectToServer("fixture", {
      url,
      mcpProtocolVersion: "2025-11-25",
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(setLevelAnswered).toBe(true));
    expect(events).toEqual([]);

    await suppressFeatureObservation(connected, "fixture", () =>
      connected.readResource("fixture", { uri: FIXTURE_GREETING_URI })
    );
    expect(events).toEqual([]);

    await connected.readResource("fixture", { uri: FIXTURE_GREETING_URI });
    expect(events.map((event) => event.featureIds)).toEqual([
      ["resources.read"],
    ]);
  });

  it("observes no modern handshake result", async () => {
    const url = await serveFixture();
    const { events, observer } = collect();
    const connected = new MCPClientManager({}, { featureObserver: observer });
    manager = connected;
    await connected.connectToServer("fixture", {
      url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    expect(events).toEqual([]);

    await connected.readResource("fixture", { uri: FIXTURE_GREETING_URI });
    expect(events.flatMap((event) => event.featureIds)).toContain(
      "resources.read"
    );
  });
});
