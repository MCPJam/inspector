import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { projectHostedConnectFailureLogs } from "../../../utils/hosted-connect-failure.js";

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  const { BlockedEgressTargetError } =
    await import("../../../utils/hosted-egress-guard.js");

  class MockMCPClientManager {
    private readonly rpcLogger?: (event: {
      direction: "send" | "receive";
      message: unknown;
      serverId: string;
    }) => void;

    constructor(
      _servers: Record<string, unknown>,
      options?: {
        rpcLogger?: (event: {
          direction: "send" | "receive";
          message: unknown;
          serverId: string;
        }) => void;
      }
    ) {
      this.rpcLogger = options?.rpcLogger;
    }

    async listTools(serverId: string) {
      if (serverId === "srv-down") throw new Error("connect ECONNREFUSED");
      // The manager dials lazily, so the egress guard's refusal surfaces
      // here, wrapped the way the transport wraps it.
      if (serverId === "srv-blocked") {
        throw new Error("fetch failed", {
          cause: new BlockedEgressTargetError(
            'Target "server.internal" is not allowed',
          ),
        });
      }
      this.rpcLogger?.({
        direction: "send",
        serverId,
        message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      this.rpcLogger?.({
        direction: "receive",
        serverId,
        message: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [{ name: `tool-${serverId}` }],
          },
        },
      });
      return { tools: [{ name: `tool-${serverId}` }] };
    }

    getAllToolsMetadata() {
      return {};
    }

    async listPrompts(serverId: string) {
      this.rpcLogger?.({
        direction: "send",
        serverId,
        message: { jsonrpc: "2.0", id: 1, method: "prompts/list" },
      });
      this.rpcLogger?.({
        direction: "receive",
        serverId,
        message: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            prompts: [{ name: `prompt-${serverId}` }],
          },
        },
      });
      return { prompts: [{ name: `prompt-${serverId}` }] };
    }

    async disconnectAllServers() {
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
import promptsRoutes from "../prompts.js";
import { toolsListSchema, withEphemeralConnection } from "../auth.js";
import { listTools } from "../../../utils/route-handlers.js";
import { expectJson, postJson } from "./helpers/test-app.js";

function createRpcLogsTestApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("guestId", "guest-1");
    await next();
  });
  app.route("/api/web/tools", toolsRoutes);
  app.route("/api/web/prompts", promptsRoutes);
  app.post("/api/web/testing/tools/list-no-rpc-logs", async (c) =>
    withEphemeralConnection(
      c,
      toolsListSchema,
      (manager, body) => listTools(manager, body),
      { rpcLogs: false }
    )
  );
  app.post("/api/web/testing/tools/list-redacted-success-logs", async (c) =>
    withEphemeralConnection(
      c,
      toolsListSchema,
      (manager, body) => listTools(manager, body),
      { redactSuccessLogs: projectHostedConnectFailureLogs }
    )
  );
  return app;
}

describe("web hosted rpc logs", () => {
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
                serverId === "srv-denied"
                  ? {
                      ok: false,
                      status: 403,
                      code: "FORBIDDEN",
                      message: "Access denied",
                    }
                  : {
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
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
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

  it("attaches rpc logs with server names to single-server hosted responses", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/list",
      {
        projectId: "project-1",
        serverId: "srv-1",
        serverName: "Notion",
      },
      "test-token"
    );

    const { status, data } = await expectJson<{
      tools: Array<{ name: string }>;
      _rpcLogs: Array<{
        serverId: string;
        serverName: string;
        direction: string;
      }>;
    }>(response);

    expect(status).toBe(200);
    expect(data.tools).toEqual([{ name: "tool-srv-1" }]);
    expect(data._rpcLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "srv-1",
          serverName: "Notion",
          direction: "send",
        }),
        expect.objectContaining({
          serverId: "srv-1",
          serverName: "Notion",
          direction: "receive",
        }),
      ])
    );
  });

  it("attaches rpc logs with aligned server names to batch hosted responses", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/prompts/list-multi",
      {
        projectId: "project-1",
        serverIds: ["srv-1", "srv-2"],
        serverNames: ["Notion", "GitHub"],
      },
      "test-token"
    );

    const { status, data } = await expectJson<{
      prompts: Record<string, Array<{ name: string }>>;
      _rpcLogs: Array<{ serverId: string; serverName: string }>;
    }>(response);

    expect(status).toBe(200);
    expect(data.prompts).toEqual({
      "srv-1": [{ name: "prompt-srv-1" }],
      "srv-2": [{ name: "prompt-srv-2" }],
    });
    expect(data._rpcLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "srv-1",
          serverName: "Notion",
        }),
        expect.objectContaining({
          serverId: "srv-2",
          serverName: "GitHub",
        }),
      ])
    );
  });

  it("attaches rpc logs with aligned server names to the tools batch", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/list-multi",
      {
        projectId: "project-1",
        serverIds: ["srv-1", "srv-2"],
        serverNames: ["Notion", "GitHub"],
      },
      "test-token",
    );

    const { status, data } = await expectJson<{
      results: Record<string, { tools: Array<{ name: string }> }>;
      _rpcLogs: Array<{ serverId: string; serverName: string }>;
    }>(response);

    expect(status).toBe(200);
    expect(data.results).toEqual({
      "srv-1": { tools: [{ name: "tool-srv-1" }], toolsMetadata: {} },
      "srv-2": { tools: [{ name: "tool-srv-2" }], toolsMetadata: {} },
    });
    expect(data._rpcLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: "srv-1", serverName: "Notion" }),
        expect.objectContaining({ serverId: "srv-2", serverName: "GitHub" }),
      ]),
    );
  });

  it("reports a server that fails inside the tools batch without failing the batch", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/list-multi",
      {
        projectId: "project-1",
        serverIds: ["srv-1", "srv-down"],
        serverNames: ["Notion", "Down"],
      },
      "test-token",
    );

    const { status, data } = await expectJson<{
      results: Record<string, { tools: Array<{ name: string }> }>;
      errors: Record<string, { status: number; code: string; message: string }>;
    }>(response);

    expect(status).toBe(200);
    expect(Object.keys(data.results)).toEqual(["srv-1"]);
    // Mapped as a single-server call's failure would be (`mapTargetServerError`:
    // a connection failure to the caller's own server is a 502 with the
    // described message), so the client can rebuild the same error.
    expect(data.errors).toEqual({
      "srv-down": {
        status: 502,
        code: "SERVER_UNREACHABLE",
        message: expect.stringContaining("connect ECONNREFUSED"),
      },
    });
  });

  it("answers an egress-refused server inside the tools batch as its own request would", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/list-multi",
      {
        projectId: "project-1",
        serverIds: ["srv-1", "srv-blocked"],
        serverNames: ["Notion", "Internal"],
      },
      "test-token",
    );

    const { status, data } = await expectJson<{
      results: Record<string, unknown>;
      errors: Record<string, { status: number; code: string; message: string }>;
    }>(response);

    expect(status).toBe(200);
    expect(Object.keys(data.results)).toEqual(["srv-1"]);
    // The guard's verdict is the caller's to change, so it is a 400 with the
    // guard's own message, as `/list` answers it, not a 502.
    expect(data.errors).toEqual({
      "srv-blocked": {
        status: 400,
        code: "VALIDATION_ERROR",
        message: 'Target "server.internal" is not allowed',
      },
    });
  });

  it("answers a server whose authorization was refused inside the tools batch", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/list-multi",
      {
        projectId: "project-1",
        serverIds: ["srv-1", "srv-denied"],
        serverNames: ["Notion", "Denied"],
      },
      "test-token",
    );

    const { status, data } = await expectJson<{
      results: Record<string, { tools: Array<{ name: string }> }>;
      errors: Record<string, { status: number; code: string; message: string }>;
      _rpcLogs: Array<{ serverId: string }>;
    }>(response);

    // The connection records the refusal per server instead of failing the
    // batch on it, and the route answers it the way its own request would
    // have been answered, next to the servers it did list.
    expect(status).toBe(200);
    expect(Object.keys(data.results)).toEqual(["srv-1"]);
    expect(data.errors).toEqual({
      "srv-denied": {
        status: 403,
        code: "FORBIDDEN",
        message: "Access denied",
      },
    });
    expect(data._rpcLogs.every((log) => log.serverId === "srv-1")).toBe(true);
  });

  it("answers a tools batch whose every server was refused", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/tools/list-multi",
      {
        projectId: "project-1",
        serverIds: ["srv-denied"],
        serverNames: ["Denied"],
      },
      "test-token",
    );

    const { status, data } = await expectJson<{
      results: Record<string, unknown>;
      errors: Record<string, { status: number }>;
    }>(response);

    expect(status).toBe(200);
    expect(data.results).toEqual({});
    expect(data.errors).toEqual({
      "srv-denied": expect.objectContaining({ status: 403 }),
    });
  });

  it("keeps hosted rpc logs request-scoped with no cross-request carryover", async () => {
    const app = createRpcLogsTestApp();

    const first = await expectJson<{
      _rpcLogs: Array<{ serverName: string }>;
    }>(
      await postJson(
        app,
        "/api/web/tools/list",
        {
          projectId: "project-1",
          serverId: "srv-1",
          serverName: "Notion",
        },
        "test-token"
      )
    );
    const second = await expectJson<{
      _rpcLogs: Array<{ serverName: string }>;
    }>(
      await postJson(
        app,
        "/api/web/tools/list",
        {
          projectId: "project-1",
          serverId: "srv-2",
          serverName: "GitHub",
        },
        "test-token"
      )
    );

    expect(first.data._rpcLogs).toHaveLength(2);
    expect(second.data._rpcLogs).toHaveLength(2);
    expect(
      first.data._rpcLogs.every((log) => log.serverName === "Notion")
    ).toBe(true);
    expect(
      second.data._rpcLogs.every((log) => log.serverName === "GitHub")
    ).toBe(true);
  });

  it("allows hosted routes to opt out of rpc log envelopes", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/testing/tools/list-no-rpc-logs",
      {
        projectId: "project-1",
        serverId: "srv-1",
        serverName: "Notion",
      },
      "test-token"
    );

    const { status, data } = await expectJson<{
      tools: Array<{ name: string }>;
      _rpcLogs?: unknown;
    }>(response);

    expect(status).toBe(200);
    expect(data.tools).toEqual([{ name: "tool-srv-1" }]);
    expect(data._rpcLogs).toBeUndefined();
  });

  it("projects the success envelope when a route redacts success logs (MJ-001)", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/testing/tools/list-redacted-success-logs",
      {
        projectId: "project-1",
        serverId: "srv-1",
        serverName: "Notion",
      },
      "test-token"
    );

    const { status, data } = await expectJson<{
      tools: Array<{ name: string }>;
      _rpcLogs: Array<{
        direction: string;
        message: Record<string, unknown>;
      }>;
    }>(response);

    expect(status).toBe(200);
    // The route's own answer is untouched.
    expect(data.tools).toEqual([{ name: "tool-srv-1" }]);
    const received = data._rpcLogs.filter((e) => e.direction === "receive");
    expect(received.length).toBeGreaterThan(0);
    for (const event of received) {
      // The target's answer is not reflected: envelope only, content omitted.
      expect(event.message.result).toBeUndefined();
      expect(event.message.contentOmitted).toBe(true);
    }
    // Frames this server sent are kept.
    const sent = data._rpcLogs.find((e) => e.direction === "send");
    expect(sent?.message).toMatchObject({ method: "tools/list" });
  });
});

// ── Harness bridge: rpcLogBus → a live turn's collector ─────────────────────
// The harness's MCP traffic arrives as separate /api/web/harness-mcp requests
// that publish to the in-process bus; the chat turn bridges those entries into
// its collector so the Logs panel fills like an emulated turn.
import {
  bridgeHarnessRpcLogsToCollector,
  createHostedRpcLogCollector,
} from "../hosted-rpc-logs.js";
import { rpcLogBus } from "../../../services/rpc-log-bus.js";

describe("bridgeHarnessRpcLogsToCollector", () => {
  it("forwards bus events for the turn's servers into the collector (with name resolution)", () => {
    const collector = createHostedRpcLogCollector({
      selectedServerIds: ["srv-1"],
      selectedServerNames: ["My Server"],
    });
    const stop = bridgeHarnessRpcLogsToCollector(["srv-1"], collector);
    try {
      rpcLogBus.publish({
        serverId: "srv-1",
        direction: "send",
        timestamp: new Date().toISOString(),
        message: { jsonrpc: "2.0", id: 1, method: "tools/call" },
      });
      rpcLogBus.publish({
        serverId: "other-srv",
        direction: "send",
        timestamp: new Date().toISOString(),
        message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
    } finally {
      stop();
    }

    const logs = collector.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      serverId: "srv-1",
      serverName: "My Server",
      direction: "send",
    });
  });

  it("stops forwarding after unsubscribe", () => {
    const collector = createHostedRpcLogCollector({
      selectedServerIds: ["srv-1"],
    });
    const stop = bridgeHarnessRpcLogsToCollector(["srv-1"], collector);
    stop();
    rpcLogBus.publish({
      serverId: "srv-1",
      direction: "receive",
      timestamp: new Date().toISOString(),
      message: {},
    });
    expect(collector.hasLogs()).toBe(false);
  });

  it("subscribes to NOTHING for an empty server list (bus treats empty filter as all)", () => {
    const collector = createHostedRpcLogCollector({});
    const stop = bridgeHarnessRpcLogsToCollector([], collector);
    try {
      rpcLogBus.publish({
        serverId: "any-srv",
        direction: "send",
        timestamp: new Date().toISOString(),
        message: {},
      });
    } finally {
      stop();
    }
    expect(collector.hasLogs()).toBe(false);
  });
});

// INS-3: a trace frame for a plugin-contributed server must name the exact
// revision that served it, so "which plugin version made this call" is
// answerable from the trace alone.
describe("HostedRpcLogCollector — plugin origin", () => {
  const ORIGIN = {
    pluginId: "pl_1",
    pluginVersionId: "pv_1",
    name: "linear",
    bundleHash: "abc123",
  };

  it("stamps frames from a plugin server and leaves ordinary servers alone", () => {
    const collector = createHostedRpcLogCollector({
      serverIds: ["srv_host", "srv_plugin"],
      serverNames: ["Host", "Plugin"],
    });
    collector.setPluginOriginByServerId({ srv_plugin: ORIGIN });

    collector.rpcLogger({
      direction: "send",
      message: {},
      serverId: "srv_plugin",
    });
    collector.rpcLogger({
      direction: "send",
      message: {},
      serverId: "srv_host",
    });

    const [pluginFrame, hostFrame] = collector.getLogs();
    expect(pluginFrame.pluginOrigin).toEqual(ORIGIN);
    // Absence is semantic — an ordinary server carries no origin key at all.
    expect("pluginOrigin" in hostFrame).toBe(false);
  });

  it("carries no origin at all when attribution never arrived", () => {
    const collector = createHostedRpcLogCollector({ serverIds: ["srv"] });
    collector.rpcLogger({ direction: "send", message: {}, serverId: "srv" });
    expect("pluginOrigin" in collector.getLogs()[0]).toBe(false);
  });
});
