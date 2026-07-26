import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * log-notification-forwarding.test.ts — proves hosted direct ops
 * (tools/execute here) flush `notifications/message` records into the
 * request's hosted RPC log collector BEFORE the ephemeral connection tears
 * down and the response is returned.
 *
 * `withEphemeralConnection`'s `forwardLogMessages(serverId)` (server/routes/
 * web/auth.ts) is what wires this: it opts a server into `"debug"` for the
 * duration of this one operation — mirroring the legacy auto-`debug` connect
 * gate the SDK already applies. The server's `notifications/message` records
 * are then captured by the manager's configured `rpcLogger` (the logging
 * transport wrapper), NOT by a second `onLogMessage` tee — teeing would
 * double every record in `_rpcLogs`.
 *
 * The mock manager below simulates the real dual-era contract proven by the
 * SDK's `logging-dual-era.integration.test.ts`: for the modern mechanism,
 * `notifications/message` arrives INLINE within the originating request's
 * response — i.e. synchronously, before the manager call's promise resolves.
 * It models the real capture path by emitting the received notification
 * through the same `rpcLogger` the transport wrapper uses (constructor option
 * 2), so by the time `runEphemeralConnection`'s `finally` disconnects the
 * server the record is already in the collector.
 *
 * ORDERING: to prove delivery happened BEFORE disconnect (not merely
 * "eventually"), `disconnectAllServers` emits a lifecycle sentinel through the
 * same `rpcLogger`. Because the collector preserves emission order, the test
 * asserts the `notifications/message` record precedes that sentinel in
 * `_rpcLogs` — a teardown-order regression (delivery after disconnect, or a
 * dropped record) would flip or break that ordering.
 */
type MockRpcLogger = (record: {
  serverId: string;
  direction: "send" | "receive";
  message: { jsonrpc: string; method?: string; params?: unknown };
}) => void;

const DISCONNECT_SENTINEL_METHOD = "test/__disconnected__";

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );

  class MockMCPClientManager {
    private readonly perRequestLevels = new Map<string, string>();
    private readonly rpcLogger?: MockRpcLogger;
    public logDelivered = false;
    public logDeliveredBeforeDisconnect = false;

    constructor(
      _servers: Record<string, unknown>,
      options?: { rpcLogger?: MockRpcLogger }
    ) {
      // Mirror the real manager: `createAuthorizedManager` passes the hosted
      // collector's `rpcLogger` as constructor option 2, and the manager wraps
      // each transport so every received wire message is logged through it.
      this.rpcLogger = options?.rpcLogger;
    }

    getLoggingMechanism(_serverId: string): "per-request-meta" {
      return "per-request-meta";
    }

    setPerRequestLogLevel(serverId: string, level: string | undefined) {
      if (level === undefined) this.perRequestLevels.delete(serverId);
      else this.perRequestLevels.set(serverId, level);
    }

    async executeTool(serverId: string, toolName: string) {
      // Only "emits" a log record when the caller opted in — matches the
      // real modern-era contract (absence of the level ⇒ no server emission
      // to react to, though here we simulate the SERVER side directly).
      if (this.perRequestLevels.has(serverId)) {
        // Delivered INLINE, synchronously, before the tool result — exactly
        // as the real modern-era stream does per the SDK integration test.
        // Captured via the transport-level `rpcLogger`, the same path the
        // real `wrapTransportForLogging` uses for received notifications.
        this.rpcLogger?.({
          serverId,
          direction: "receive",
          message: {
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "debug", data: `log from ${toolName}` },
          },
        });
        this.logDelivered = true;
      }
      return {
        content: [{ type: "text", text: "ok" }],
      };
    }

    async disconnectAllServers() {
      // Snapshot whether the log was already delivered when teardown runs: a
      // teardown-order regression would leave this false. Also emit a
      // lifecycle sentinel through the collector so the ordering is observable
      // in the response `_rpcLogs` (the notification must precede it).
      this.logDeliveredBeforeDisconnect = this.logDelivered;
      this.rpcLogger?.({
        serverId: "__lifecycle__",
        direction: "receive",
        message: { jsonrpc: "2.0", method: DISCONNECT_SENTINEL_METHOD },
      });
      return undefined;
    }
  }

  return {
    ...actual,
    MCPClientManager: MockMCPClientManager,
    isMCPAuthError: vi.fn().mockReturnValue(false),
  };
});

import toolsRoutes from "../tools.js";
import { expectJson, postJson } from "./helpers/test-app.js";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("guestId", "guest-1");
    await next();
  });
  app.route("/api/web/tools", toolsRoutes);
  return app;
}

describe("hosted tools/execute forwards notifications/message before the response closes", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    global.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("/web/authorize-batch")) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        const serverIds = Array.isArray(payload?.serverIds)
          ? payload.serverIds
          : [];
        return new Response(
          JSON.stringify({
            results: Object.fromEntries(
              serverIds.map((serverId: string) => [
                serverId,
                {
                  ok: true,
                  role: "member",
                  accessLevel: "project_member",
                  permissions: { chatOnly: false },
                  serverConfig: {
                    transportType: "http",
                    url: "https://server.example.com/mcp",
                    headers: {},
                    useOAuth: false,
                  },
                },
              ])
            ),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl) {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("includes the notifications/message record in the response's _rpcLogs envelope", async () => {
    const app = createTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/execute",
      {
        projectId: "project-1",
        serverId: "srv-1",
        serverName: "Notion",
        toolName: "emit_log",
        parameters: {},
      },
      "test-token"
    );

    const { status, data } = await expectJson<{
      result: unknown;
      _rpcLogs: Array<{
        serverId: string;
        direction: string;
        message: { method?: string };
      }>;
    }>(response);

    expect(status).toBe(200);
    const logIndex = data._rpcLogs.findIndex(
      (entry) => entry.message?.method === "notifications/message"
    );
    expect(
      logIndex,
      "notifications/message forwarded into the hosted rpc log envelope"
    ).toBeGreaterThanOrEqual(0);
    expect(data._rpcLogs[logIndex]).toMatchObject({
      serverId: "srv-1",
      direction: "receive",
    });

    // ORDERING: prove the record was in the collector BEFORE the ephemeral
    // connection tore down. The mock's `disconnectAllServers` emits a
    // lifecycle sentinel through the same collector, so the notification must
    // appear strictly before it — a teardown-order regression (delivery after
    // disconnect, or a dropped record) would flip or break this ordering.
    const disconnectIndex = data._rpcLogs.findIndex(
      (entry) => entry.message?.method === DISCONNECT_SENTINEL_METHOD
    );
    expect(
      disconnectIndex,
      "disconnect lifecycle sentinel present in the envelope"
    ).toBeGreaterThanOrEqual(0);
    expect(
      logIndex,
      "notifications/message recorded BEFORE the ephemeral disconnect"
    ).toBeLessThan(disconnectIndex);
  });
});
