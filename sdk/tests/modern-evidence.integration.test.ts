import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { withEphemeralClient } from "../src/operations.js";
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

  // ── SEP-2243 mirroring on a COLD client ────────────────────────────────
  //
  // The test above warms the client's `tools/list` response cache by hand.
  // These prove the MUST holds on the surfaces that never do — a hosted or CLI
  // ephemeral connection that only ever calls the tool, and a surface that
  // walks pagination itself (an explicit-`{ cursor }` list writes no cache).

  it("mirrors Mcp-Param-* on a cold client — no prior listTools", async () => {
    const { manager } = await connectModern();
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeDefined();
    // The mirroring source was warmed: the aggregating walk ran (one request
    // per fixture page) even though the caller never listed.
    expect(byMethod("tools/list").length).toBeGreaterThan(0);
  });

  it("warms the mirroring source at most once per connection", async () => {
    const { manager } = await connectModern();
    await manager.executeTool("fixture", "tool-0", { message: "one" });
    const listsAfterFirstCall = byMethod("tools/list").length;
    await manager.executeTool("fixture", "tool-0", { message: "two" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.request.headers["mcp-param-message"]).toBeDefined();
    }
    // The second call reuses the warmed source — it must not re-walk the list.
    expect(byMethod("tools/list")).toHaveLength(listsAfterFirstCall);
  });

  it("mirrors after an explicit-cursor listTools, which writes no cache", async () => {
    const { manager } = await connectModern();
    // A hand-walked page: upstream returns the raw page and deliberately does
    // not write the response cache, so this leaves the mirroring source cold.
    await manager.listTools("fixture", { cursor: "page-1" });
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeDefined();
  });

  it("mirrors Mcp-Param-* when an MRTR collector is registered", async () => {
    // The regression this guards is not an exotic one. Every connected server
    // gets an MRTR collector — registering one is what makes the client
    // advertise `elicitation` at all — so `executeTool` takes the
    // `input_required` path for EVERY modern tools/call, elicitation or not.
    // That path sends its legs through `requestWithSchema`, which does not
    // inherit upstream `callTool`'s mirroring. While it went unmirrored, a
    // conforming 2026 server answered every call with -32020 HeaderMismatch.
    const { manager } = await connectModern();
    manager.setMrtrInputCollector("fixture", async () => {
      throw new Error("tool-0 completes on the first leg; must not elicit");
    });
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.request.headers;
    expect(headers["mcp-param-message"]).toBeDefined();
    // The standard three must still be intact — the mirrored params ride
    // alongside them, they do not replace the options object that carries them.
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("tool-0");
  });

  it("a no-cursor listTools already warmed it — tools/call adds no second list", async () => {
    const { manager } = await connectModern();
    await manager.listTools("fixture");
    const listsAfterWarm = byMethod("tools/list").length;
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    expect(byMethod("tools/list")).toHaveLength(listsAfterWarm);
    expect(
      byMethod("tools/call")[0]!.request.headers["mcp-param-message"]
    ).toBeDefined();
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

    // Deterministic proof the tools/call actually reached the fixture before
    // we abort — a held-open call never lands in `exchanges` (its response
    // never completes), so a fixed sleep here would let the test pass without
    // ever dispatching the request. `waitForToolCall` resolves the instant the
    // handler receives it.
    await served!.waitForToolCall("slow-tool");
    controller.abort();

    // The dispatched, held-open call must reject as a consequence of the abort
    // (not resolve with `slow-tool finished`).
    const outcome = await callPromise.then(
      () => "resolved" as const,
      (err) => err
    );
    expect(outcome).not.toBe("resolved");
    expect(outcome).toBeTruthy();

    // The spec cancellation signal on modern is the aborted per-request
    // stream itself — there must be no explicit notifications/cancelled
    // POST alongside it.
    expect(byMethod("notifications/cancelled")).toHaveLength(0);
  });
});

/**
 * SEP-2243 mirroring on the EPHEMERAL surface — `withEphemeralClient` is the
 * shared connect → one op → disconnect lifecycle behind `mcpjam tools call`
 * (via the CLI's `withEphemeralManager`) and structurally identical to the
 * hosted `/api/web/tools/execute` per-request connection. Neither lists tools
 * before calling one, so this is the surface the MUST was actually being
 * skipped on — a wrapper-level assertion on the manager alone would not show
 * it.
 */
describe("SEP-2243 mirroring on an ephemeral (connect → call → disconnect) surface", () => {
  let served: ServedMultiPageFixture | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it("mirrors Mcp-Param-* when the only op on the connection is the tools/call", async () => {
    served = await serveMultiPageFixtureOnPort();

    await withEphemeralClient(
      {
        url: served.url,
        mcpProtocolVersion: "2026-07-28",
        timeout: 10_000,
      },
      async (manager, serverId) => {
        await manager.executeTool(serverId, "tool-0", { message: "hi" });
      },
      { serverId: "__cli__", timeout: 10_000 }
    );

    const calls = served.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/call"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeDefined();
  });

  it("legacy (2025-11-25) is untouched: no warm-up list, no Mcp-Param-* header", async () => {
    served = await serveMultiPageFixtureOnPort();

    await withEphemeralClient(
      {
        url: served.url,
        mcpProtocolVersion: "2025-11-25",
        timeout: 10_000,
      },
      async (manager, serverId) => {
        await manager.executeTool(serverId, "tool-0", { message: "hi" });
      },
      { serverId: "__cli__", timeout: 10_000 }
    );

    const methods = served.exchanges.map((e) =>
      getWireField(e.request.json, "method")
    );
    // The mirroring warm-up is modern-only: a legacy connection must issue the
    // exact same wire it did before — a tools/call and nothing else.
    expect(methods.filter((m) => m === "tools/list")).toHaveLength(0);
    const calls = served.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/call"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeUndefined();
  });
});
