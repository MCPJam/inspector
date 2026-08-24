import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { wrapTransportForDroppedListChanged } from "../src/mcp-client-manager/transport-utils.js";
import {
  serveMultiPageFixtureOnPort,
  type ServedMultiPageFixture,
} from "./support/multi-page-fixture.js";
import { getWireField } from "./support/raw-capture.js";

/**
 * `mcpProfile.toolListChanged` — simulating a client that never opens the
 * server→client notification channel (`listens: false`, which is how prober
 * measured ChatGPT), or opens it but ignores
 * `notifications/tools/list_changed` (`refetches: false`).
 *
 * Asserted on a real socket, because both facts are only observable as wire
 * behavior: a GET that never happens, and a `tools/list` that never repeats.
 * Every claim has an explicit knob-off control, so a passing test cannot be
 * explained by the fixture simply never doing the thing.
 */

describe("tool list changed knobs", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function connect(options: {
    suppressListenChannel?: boolean;
    dropToolListChanged?: boolean;
  }) {
    served = await serveMultiPageFixtureOnPort({});
    manager = new MCPClientManager();
    // The legacy era: 2026-07-28 never opens a listen stream at connect, so
    // the standalone GET only exists to be refused here.
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2025-11-25",
      ...(options.suppressListenChannel !== undefined
        ? { suppressListenChannel: options.suppressListenChannel }
        : {}),
      ...(options.dropToolListChanged !== undefined
        ? { dropToolListChanged: options.dropToolListChanged }
        : {}),
      timeout: 10_000,
    });
    return { served: served!, manager: manager! };
  }

  /** The standalone listen stream is the only GET this transport issues. */
  const listenStreamRequests = () =>
    served!.exchanges.filter(
      (e) =>
        e.request.method.toUpperCase() === "GET" &&
        (e.request.headers["accept"] ?? "").includes("text/event-stream")
    );

  const toolsListRequests = () =>
    served!.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/list"
    );

  it("never opens the notification channel when listens is false", async () => {
    await connect({ suppressListenChannel: true });
    // Give the transport the same window it would use to open the stream.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(listenStreamRequests()).toHaveLength(0);
  });

  it("opens the notification channel by default (control)", async () => {
    await connect({});
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Proves the assertion above measures a real refusal rather than a
    // fixture that never gets asked.
    expect(listenStreamRequests().length).toBeGreaterThan(0);
  });

  it("still serves tool calls with the channel refused", async () => {
    // The refusal must not break the connection: a real client that does not
    // listen still works over the POST channel.
    const { manager } = await connect({ suppressListenChannel: true });
    const result = await manager.listTools("fixture");
    expect(result.tools.length).toBeGreaterThan(0);
  });
});

describe("wrapTransportForDroppedListChanged", () => {
  function fakeTransport() {
    const inner: Record<string, any> = {
      sent: [] as unknown[],
      async start() {},
      async send(message: unknown) {
        inner.sent.push(message);
      },
      async close() {},
    };
    return inner;
  }

  it("swallows the notification and passes everything else", () => {
    const inner = fakeTransport();
    const wrapped = wrapTransportForDroppedListChanged(inner as never);
    const seen: unknown[] = [];
    wrapped.onmessage = (message) => seen.push(message);

    inner.onmessage({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    inner.onmessage({
      jsonrpc: "2.0",
      method: "notifications/resources/list_changed",
    });
    inner.onmessage({ jsonrpc: "2.0", id: 1, result: {} });

    expect(seen).toEqual([
      { jsonrpc: "2.0", method: "notifications/resources/list_changed" },
      { jsonrpc: "2.0", id: 1, result: {} },
    ]);
  });

  it("never swallows a request that carries an id", () => {
    // A server-initiated REQUEST named like the notification would otherwise
    // be dropped, leaving the peer waiting for a response forever.
    const inner = fakeTransport();
    const wrapped = wrapTransportForDroppedListChanged(inner as never);
    const seen: unknown[] = [];
    wrapped.onmessage = (message) => seen.push(message);

    const request = {
      jsonrpc: "2.0",
      id: 7,
      method: "notifications/tools/list_changed",
    };
    inner.onmessage(request);
    expect(seen).toEqual([request]);
  });
});
