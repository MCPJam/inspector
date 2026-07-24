import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { serveMultiPageFixtureOnPort, type ServedMultiPageFixture } from "./support/multi-page-fixture.js";
import { getWireField } from "./support/raw-capture.js";

/**
 * Phase 3 §11.1 — modern-era (2026-07-28) wire evidence, Node-side only
 * (uses `node:http`, so this does not run in a browser/worker environment).
 *
 * Companion to `pagination-parity.integration.test.ts`: that suite proves
 * pagination; this one proves the modern-era wire invariants MCPClientManager
 * is supposed to preserve when pinned to `2026-07-28` — SEP-2243 standard
 * headers, no session stickiness, correct negotiated-version reporting, and
 * abort-as-cancellation (no `notifications/cancelled` POST).
 */

describe("modern-era (2026-07-28) wire evidence", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function connectModern() {
    served = await serveMultiPageFixtureOnPort();
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    return { served, manager };
  }

  function byMethod(method: string) {
    return served!.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === method
    );
  }

  it("negotiates 2026-07-28 and getInitializationInfo reports it", async () => {
    const { manager } = await connectModern();
    const info = manager.getInitializationInfo("fixture");
    expect(info?.protocolVersion).toBe("2026-07-28");
  });

  it("tools/call carries Mcp-Method, Mcp-Name, and Mcp-Param-Message headers", async () => {
    const { manager } = await connectModern();
    // Populate the client's response cache with `tool-0`'s inputSchema (the
    // x-mcp-header scan reads from a CACHED tools/list entry, not from the
    // call itself).
    await manager.listTools("fixture");
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.request.headers;
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("tool-0");
    expect(headers["mcp-param-message"]).toBeDefined();
  });

  it("never retains or re-sends Mcp-Session-Id on modern requests", async () => {
    const { manager } = await connectModern();
    await manager.listTools("fixture");
    await manager.listPrompts("fixture");
    await manager.executeTool("fixture", "echo", { message: "hi" });

    for (const exchange of served!.exchanges) {
      expect(exchange.request.headers["mcp-session-id"]).toBeUndefined();
      expect(exchange.response.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  it("aborting requestOptions.signal mid tools/call aborts the fetch and sends NO notifications/cancelled", async () => {
    const { manager } = await connectModern();
    const controller = new AbortController();
    const callPromise = manager.executeTool(
      "fixture",
      "slow-tool",
      { delayMs: 60_000 },
      { signal: controller.signal }
    );

    // Give the request time to actually reach the server before aborting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(callPromise).rejects.toBeTruthy();

    // The spec cancellation signal on modern is the aborted per-request
    // stream itself — there must be no explicit notifications/cancelled
    // POST alongside it.
    expect(byMethod("notifications/cancelled")).toHaveLength(0);
  });
});
