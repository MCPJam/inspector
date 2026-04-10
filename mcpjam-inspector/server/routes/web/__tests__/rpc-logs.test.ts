import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk",
  );

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
      },
    ) {
      this.rpcLogger = options?.rpcLogger;
    }

    async listTools(serverId: string) {
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
      { rpcLogs: false },
    ),
  );
  return app;
}

describe("web hosted rpc logs", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    global.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/web/authorize")) {
        return new Response(
          JSON.stringify({
            authorized: true,
            role: "member",
            accessLevel: "workspace_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://server.example.com/mcp",
              headers: {},
              useOAuth: false,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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
        workspaceId: "workspace-1",
        serverId: "srv-1",
        serverName: "Notion",
      },
      "test-token",
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
      ]),
    );
  });

  it("attaches rpc logs with aligned server names to batch hosted responses", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/prompts/list-multi",
      {
        workspaceId: "workspace-1",
        serverIds: ["srv-1", "srv-2"],
        serverNames: ["Notion", "GitHub"],
      },
      "test-token",
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
      ]),
    );
  });

  it("uses the provided guest server name instead of __guest__ in rpc logs", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(app, "/api/web/tools/list", {
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Excalidraw (App)",
    });

    const { status, data } = await expectJson<{
      _rpcLogs: Array<{ serverId: string; serverName: string }>;
    }>(response);

    expect(status).toBe(200);
    expect(data._rpcLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverId: "__guest__",
          serverName: "Excalidraw (App)",
        }),
      ]),
    );
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
          workspaceId: "workspace-1",
          serverId: "srv-1",
          serverName: "Notion",
        },
        "test-token",
      ),
    );
    const second = await expectJson<{
      _rpcLogs: Array<{ serverName: string }>;
    }>(
      await postJson(
        app,
        "/api/web/tools/list",
        {
          workspaceId: "workspace-1",
          serverId: "srv-2",
          serverName: "GitHub",
        },
        "test-token",
      ),
    );

    expect(first.data._rpcLogs).toHaveLength(2);
    expect(second.data._rpcLogs).toHaveLength(2);
    expect(
      first.data._rpcLogs.every((log) => log.serverName === "Notion"),
    ).toBe(true);
    expect(
      second.data._rpcLogs.every((log) => log.serverName === "GitHub"),
    ).toBe(true);
  });

  it("allows hosted routes to opt out of rpc log envelopes", async () => {
    const app = createRpcLogsTestApp();

    const response = await postJson(
      app,
      "/api/web/testing/tools/list-no-rpc-logs",
      {
        workspaceId: "workspace-1",
        serverId: "srv-1",
        serverName: "Notion",
      },
      "test-token",
    );

    const { status, data } = await expectJson<{
      tools: Array<{ name: string }>;
      _rpcLogs?: unknown;
    }>(response);

    expect(status).toBe(200);
    expect(data.tools).toEqual([{ name: "tool-srv-1" }]);
    expect(data._rpcLogs).toBeUndefined();
  });
});
