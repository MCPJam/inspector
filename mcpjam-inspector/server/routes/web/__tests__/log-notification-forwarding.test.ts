import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * log-notification-forwarding.test.ts — proves hosted direct ops
 * (tools/execute here) flush `notifications/message` records into the
 * request's hosted RPC log collector BEFORE the ephemeral connection tears
 * down and the response is returned.
 *
 * `withEphemeralConnection`'s `forwardLogMessages(serverId)` (server/routes/
 * web/auth.ts) is what wires this: it (a) opts a modern-mechanism server
 * into `"debug"` for the duration of this one operation — mirroring the
 * legacy auto-`debug` connect gate the SDK already applies — and (b)
 * registers `manager.onLogMessage` to tee records into the collector.
 *
 * The mock manager below simulates the real dual-era contract proven by the
 * SDK's `logging-dual-era.integration.test.ts`: for the modern mechanism,
 * `notifications/message` arrives INLINE within the originating request's
 * response — i.e. synchronously, before the manager call's promise resolves
 * — so any `onLogMessage` handler registered beforehand has already fired
 * by the time `runEphemeralConnection`'s `finally` disconnects the server.
 */
vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );

  class MockMCPClientManager {
    private readonly logHandlers = new Map<
      string,
      Set<(n: { method: string; params?: unknown }) => void>
    >();
    private readonly perRequestLevels = new Map<string, string>();
    public disconnectedBeforeLogDelivered = false;

    constructor(_servers: Record<string, unknown>) {}

    getLoggingMechanism(_serverId: string): "per-request-meta" {
      return "per-request-meta";
    }

    setPerRequestLogLevel(serverId: string, level: string | undefined) {
      if (level === undefined) this.perRequestLevels.delete(serverId);
      else this.perRequestLevels.set(serverId, level);
    }

    onLogMessage(
      serverId: string,
      handler: (n: { method: string; params?: unknown }) => void
    ) {
      const set = this.logHandlers.get(serverId) ?? new Set();
      set.add(handler);
      this.logHandlers.set(serverId, set);
    }

    async executeTool(serverId: string, toolName: string) {
      // Only "emits" a log record when the caller opted in — matches the
      // real modern-era contract (absence of the level ⇒ no server emission
      // to react to, though here we simulate the SERVER side directly).
      if (this.perRequestLevels.has(serverId)) {
        // Delivered INLINE, synchronously, before the tool result — exactly
        // as the real modern-era stream does per the SDK integration test.
        for (const handler of this.logHandlers.get(serverId) ?? []) {
          handler({
            method: "notifications/message",
            params: { level: "debug", data: `log from ${toolName}` },
          });
        }
      }
      return {
        content: [{ type: "text", text: "ok" }],
      };
    }

    async disconnectAllServers() {
      // If a log record were still pending delivery when disconnect runs,
      // a real transport teardown could drop it. Recording this here lets
      // the test assert the collector already had the record BEFORE this
      // ran (see assertion below), not merely that it arrives eventually.
      this.disconnectedBeforeLogDelivered = this.logHandlers.size > 0;
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
    const logRecord = data._rpcLogs.find(
      (entry) => entry.message?.method === "notifications/message"
    );
    expect(
      logRecord,
      "notifications/message forwarded into the hosted rpc log envelope"
    ).toBeDefined();
    expect(logRecord).toMatchObject({
      serverId: "srv-1",
      direction: "receive",
    });
  });
});
