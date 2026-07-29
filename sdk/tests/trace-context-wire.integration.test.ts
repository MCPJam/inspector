import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  BAGGAGE_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from "@modelcontextprotocol/client";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { createLoggingFixtureHandler } from "./support/logging-fixture.js";
import {
  createCapturingFetch,
  getWireField,
  hasWireField,
  type RawExchange,
} from "./support/raw-capture.js";

/**
 * Wire-level proof for OpenTelemetry trace-context propagation over `_meta`.
 *
 * The three reserved keys are a 2026-07-28 convention, so the guarantee this
 * file exists to hold is two-sided:
 *
 *   - MODERN (2026-07-28): a provider-supplied context rides `_meta` on every
 *     routed request, under the bare `traceparent` / `tracestate` / `baggage`
 *     names (NOT under the `io.modelcontextprotocol/` prefix).
 *   - LEGACY (every 2025 version): the keys NEVER appear, even with the same
 *     provider wired — the legacy wire is byte-identical to no provider at
 *     all.
 *
 * As in `logging-dual-era.integration.test.ts`, the manager's transport dials
 * the global `fetch`, so we tee it to read raw frames BEFORE the client
 * normalizes away the `_meta` envelope.
 */

const TRACEPARENT =
  "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01";
const TRACESTATE = "rojo=00f067aa0ba902b7";
const BAGGAGE = "userId=alice";

/** Every 2025-era version the debugger can pin. */
const LEGACY_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixture(): Promise<ServedFixture> {
  const httpServer = http.createServer(
    toNodeHandler(createLoggingFixtureHandler()),
  );
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
function requestExchanges(exchanges: RawExchange[], from = 0): RawExchange[] {
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

describe("trace context — wire propagation", () => {
  let served: ServedFixture;
  let manager: MCPClientManager;
  let cap: ReturnType<typeof createCapturingFetch>;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    served = await serveFixture();
    realFetch = globalThis.fetch;
    cap = createCapturingFetch(realFetch);
    globalThis.fetch = cap.fetch as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await manager?.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("MODERN + provider puts all three reserved keys on every request", async () => {
    manager = new MCPClientManager(
      {},
      {
        traceContextProvider: () => ({
          traceparent: TRACEPARENT,
          tracestate: TRACESTATE,
          baggage: BAGGAGE,
        }),
      },
    );
    await manager.connectToServer("srv", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });

    const start = cap.exchanges.length;
    await manager.listTools("srv");
    await manager.listPrompts("srv");

    const routed = requestExchanges(cap.exchanges, start);
    expect(routed.length).toBeGreaterThan(0);
    for (const ex of routed) {
      const method = getWireField(ex.request.json, "method");
      expect(
        getWireField(ex.request.json, ["params", "_meta", TRACEPARENT_META_KEY]),
        `${method} carries traceparent`,
      ).toBe(TRACEPARENT);
      expect(
        getWireField(ex.request.json, ["params", "_meta", TRACESTATE_META_KEY]),
      ).toBe(TRACESTATE);
      expect(
        getWireField(ex.request.json, ["params", "_meta", BAGGAGE_META_KEY]),
      ).toBe(BAGGAGE);
      // The keys are deliberately NOT under the MCP prefix.
      expect(
        hasWireField(ex.request.json, [
          "params",
          "_meta",
          "io.modelcontextprotocol/traceparent",
        ]),
      ).toBe(false);
    }
  });

  it("MODERN with no provider emits no trace keys at all", async () => {
    manager = new MCPClientManager();
    await manager.connectToServer("srv", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });

    await manager.listTools("srv");

    for (const ex of requestExchanges(cap.exchanges)) {
      for (const key of [
        TRACEPARENT_META_KEY,
        TRACESTATE_META_KEY,
        BAGGAGE_META_KEY,
      ]) {
        expect(
          hasWireField(ex.request.json, ["params", "_meta", key]),
          `${getWireField(ex.request.json, "method")} omits ${key}`,
        ).toBe(false);
      }
    }
  });

  it.each(LEGACY_VERSIONS)(
    "LEGACY %s never carries the keys even with a provider wired",
    async (version) => {
      manager = new MCPClientManager(
        {},
        {
          traceContextProvider: () => ({
            traceparent: TRACEPARENT,
            tracestate: TRACESTATE,
            baggage: BAGGAGE,
          }),
        },
      );
      await manager.connectToServer("srv", {
        url: served.url,
        mcpProtocolVersion: version,
        timeout: 10_000,
      });

      await manager.listTools("srv");
      await manager.listPrompts("srv");

      const routed = requestExchanges(cap.exchanges);
      expect(routed.length).toBeGreaterThan(0);
      for (const ex of routed) {
        for (const key of [
          TRACEPARENT_META_KEY,
          TRACESTATE_META_KEY,
          BAGGAGE_META_KEY,
        ]) {
          expect(
            hasWireField(ex.request.json, ["params", "_meta", key]),
            `${version} ${getWireField(ex.request.json, "method")} omits ${key}`,
          ).toBe(false);
        }
      }
    },
  );
});
