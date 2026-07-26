import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/client";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { LogLevelMetaClient } from "../src/mcp-client-manager/log-level-meta-client.js";
import type {
  ManagedMcpClient,
  ManagedMcpClientNotification,
} from "../src/mcp-client-manager/managed-mcp-client.js";
import type { RpcLogEvent } from "../src/mcp-client-manager/types.js";
import {
  createLoggingFixtureHandler,
  EMIT_LOG_TOOL_NAME,
} from "./support/logging-fixture.js";
import {
  createCapturingFetch,
  getWireField,
  hasWireField,
  type RawExchange,
} from "./support/raw-capture.js";

/**
 * Dual-era logging integration for MCPJam's one-concept, two-delivery model:
 *
 *   - MODERN (2026-07-28): per-request opt-in rides `_meta[LOG_LEVEL_META_KEY]`
 *     on every request, injected by `LogLevelMetaClient`. Opt-out ⇒ the key is
 *     absent (absence is semantic).
 *   - LEGACY (2025-era): the level is delivered once via `logging/setLevel` on
 *     connect; the `_meta` key never rides the wire.
 *
 * The manager transport uses the global `fetch`, so we tee it through
 * `createCapturingFetch` to inspect raw frames BEFORE SDK normalization (the
 * client hides the `_meta` envelope), and serve the fixture over a real
 * loopback port (`serveLoggingFixtureOnPort`).
 */

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveLoggingFixtureOnPort(): Promise<ServedFixture> {
  const handler = createLoggingFixtureHandler();
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/** Client→server JSON-RPC REQUESTS (have both `method` and `id`) in a window. */
function requestExchanges(
  exchanges: RawExchange[],
  from = 0,
): RawExchange[] {
  return exchanges.slice(from).filter((e) => {
    const json = e.request.json as
      | { method?: unknown; id?: unknown }
      | undefined;
    return (
      json != null &&
      typeof json.method === "string" &&
      json.id !== undefined
    );
  });
}

function requestsWithMethod(
  exchanges: RawExchange[],
  method: string,
): RawExchange[] {
  return exchanges.filter(
    (e) => getWireField(e.request.json, "method") === method,
  );
}

describe("logging — dual-era delivery", () => {
  let served: ServedFixture;
  let manager: MCPClientManager;
  let cap: ReturnType<typeof createCapturingFetch>;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    served = await serveLoggingFixtureOnPort();
    realFetch = globalThis.fetch;
    cap = createCapturingFetch(realFetch);
    // The manager's transport dials the global `fetch`; tee it.
    globalThis.fetch = cap.fetch as typeof fetch;
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("MODERN + opt-in injects the level on every request; opt-out drops the key", async () => {
    manager.setPerRequestLogLevel("srv", "warning");
    await manager.connectToServer("srv", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    expect(manager.getLoggingMechanism("srv")).toBe("per-request-meta");

    // --- opt-in window: level is set, so every routed request carries it ---
    const optInStart = cap.exchanges.length;
    await manager.listTools("srv");
    await manager.executeTool("srv", EMIT_LOG_TOOL_NAME, {});

    const optIn = requestExchanges(cap.exchanges, optInStart);
    expect(optIn.length).toBeGreaterThan(0);
    for (const ex of optIn) {
      expect(
        getWireField(ex.request.json, ["params", "_meta", LOG_LEVEL_META_KEY]),
        `${getWireField(ex.request.json, "method")} carries the opt-in level`,
      ).toBe("warning");
    }

    // The modern log records ride the ORIGINATING request's response stream:
    // assert on the single tools/call fetch — no separate GET channel.
    const [call] = requestsWithMethod(optIn, "tools/call");
    expect(call, "tools/call captured").toBeDefined();
    const streamed = (call!.response.sse ?? []).some(
      (frame) => getWireField(frame.json, "method") === "notifications/message",
    );
    expect(streamed, "notifications/message in the tools/call response stream").toBe(
      true,
    );

    // --- opt-out window: absence is semantic — the key must be ABSENT ---
    manager.setPerRequestLogLevel("srv", undefined);
    const optOutStart = cap.exchanges.length;
    await manager.listTools("srv");
    await manager.executeTool("srv", EMIT_LOG_TOOL_NAME, {});

    const optOut = requestExchanges(cap.exchanges, optOutStart);
    expect(optOut.length).toBeGreaterThan(0);
    for (const ex of optOut) {
      expect(
        hasWireField(ex.request.json, ["params", "_meta", LOG_LEVEL_META_KEY]),
        `${getWireField(ex.request.json, "method")} omits the key when opted out`,
      ).toBe(false);
    }
  });

  it("LEGACY sends logging/setLevel once on connect and never the _meta key", async () => {
    // A per-request level is set, but the legacy era must ignore it for wire
    // injection (delivery is via logging/setLevel instead).
    manager.setPerRequestLogLevel("srv", "warning");
    await manager.connectToServer("srv", {
      url: served.url,
      timeout: 10_000,
    });
    expect(manager.getLoggingMechanism("srv")).toBe("setLevel");

    await manager.listTools("srv");
    await manager.executeTool("srv", EMIT_LOG_TOOL_NAME, {});

    // Auto-`setLoggingLevel("debug")` fired once on connect (capability-gated).
    const setLevel = requestsWithMethod(
      requestExchanges(cap.exchanges),
      "logging/setLevel",
    );
    expect(setLevel.length).toBe(1);
    expect(getWireField(setLevel[0].request.json, "params.level")).toBe("debug");

    // The modern per-request key never appears on the legacy wire.
    for (const ex of requestExchanges(cap.exchanges)) {
      expect(
        hasWireField(ex.request.json, ["params", "_meta", LOG_LEVEL_META_KEY]),
      ).toBe(false);
    }
  });

  it("onLogMessage receives notifications on BOTH eras", async () => {
    // Modern.
    manager.setPerRequestLogLevel("modern", "debug");
    await manager.connectToServer("modern", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    const modernLogs: ManagedMcpClientNotification[] = [];
    manager.onLogMessage("modern", (n) => modernLogs.push(n));
    await manager.executeTool("modern", EMIT_LOG_TOOL_NAME, {});
    expect(modernLogs.length).toBeGreaterThan(0);
    expect(modernLogs.every((n) => n.method === "notifications/message")).toBe(
      true,
    );

    // Legacy.
    await manager.connectToServer("legacy", {
      url: served.url,
      timeout: 10_000,
    });
    const legacyLogs: ManagedMcpClientNotification[] = [];
    manager.onLogMessage("legacy", (n) => legacyLogs.push(n));
    await manager.executeTool("legacy", EMIT_LOG_TOOL_NAME, {});
    expect(legacyLogs.length).toBeGreaterThan(0);
    expect(legacyLogs.every((n) => n.method === "notifications/message")).toBe(
      true,
    );
  });

  it("the rpcLogger tee records the raw notifications/message frames", async () => {
    const events: RpcLogEvent[] = [];
    await manager.connectToServer("srv", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
      rpcLogger: (e) => events.push(e),
    });
    manager.setPerRequestLogLevel("srv", "debug");
    await manager.executeTool("srv", EMIT_LOG_TOOL_NAME, {});

    const logRecords = events.filter(
      (e) =>
        e.direction === "receive" &&
        typeof e.message === "object" &&
        e.message != null &&
        (e.message as { method?: unknown }).method === "notifications/message",
    );
    expect(logRecords.length).toBeGreaterThan(0);
  });
});

/**
 * Focused decorator semantics — merge precedence and era gating — exercised
 * directly, since the manager's tool-call surface does not expose a
 * caller-supplied `_meta` seam to thread through.
 */
describe("LogLevelMetaClient — merge precedence and era gating", () => {
  function stubInner(era: "legacy" | "modern" | undefined) {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const inner = {
      getProtocolEra: () => era,
      callTool: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { content: [] };
      },
    } as unknown as ManagedMcpClient;
    return { inner, calls };
  }

  it("injects on modern and lets caller _meta keys win", async () => {
    const { inner, calls } = stubInner("modern");
    const client = new LogLevelMetaClient(inner, () => "warning");

    await client.callTool({
      name: "x",
      arguments: {},
      // Caller supplies its OWN value for the same key + an unrelated key.
      _meta: {
        [LOG_LEVEL_META_KEY]: "error",
        "caller.custom": "keep-me",
      },
    } as Parameters<ManagedMcpClient["callTool"]>[0]);

    const meta = (calls[0]?._meta ?? {}) as Record<string, unknown>;
    // Caller wins over the injected level.
    expect(meta[LOG_LEVEL_META_KEY]).toBe("error");
    // Caller's unrelated key is preserved.
    expect(meta["caller.custom"]).toBe("keep-me");
  });

  it("injects the manager level when the caller supplies no _meta", async () => {
    const { inner, calls } = stubInner("modern");
    const client = new LogLevelMetaClient(inner, () => "info");

    await client.callTool({ name: "x", arguments: {} });

    const meta = (calls[0]?._meta ?? {}) as Record<string, unknown>;
    expect(meta[LOG_LEVEL_META_KEY]).toBe("info");
  });

  it("does NOT inject on the legacy era", async () => {
    const { inner, calls } = stubInner("legacy");
    const client = new LogLevelMetaClient(inner, () => "warning");

    await client.callTool({ name: "x", arguments: {} });

    expect(calls[0]?._meta).toBeUndefined();
  });

  it("does NOT inject when no level is set (opt-out)", async () => {
    const { inner, calls } = stubInner("modern");
    const client = new LogLevelMetaClient(inner, () => undefined);

    await client.callTool({ name: "x", arguments: {} });

    expect(calls[0]?._meta).toBeUndefined();
  });
});
