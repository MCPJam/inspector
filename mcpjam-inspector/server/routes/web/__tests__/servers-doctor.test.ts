import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { runServerDoctorMock } = vi.hoisted(() => ({
  runServerDoctorMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");

  return {
    ...actual,
    DEFAULT_RETRY_POLICY: actual.DEFAULT_RETRY_POLICY,
    runServerDoctor: runServerDoctorMock,
    isMCPAuthError: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../../../utils/oauth-proxy.js", () => ({
  OAuthProxyError: class OAuthProxyError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  validateUrl: vi.fn().mockResolvedValue({
    url: new URL("https://guest.example.com/mcp"),
  }),
}));

vi.mock("../../apps/SandboxProxyHtml.bundled", () => ({
  CHATGPT_APPS_SANDBOX_PROXY_HTML: "<html></html>",
  MCP_APPS_SANDBOX_PROXY_HTML: "<html></html>",
}));

import webRoutes from "../index.js";
import serversRoutes from "../servers.js";
import { expectJson, postJson } from "./helpers/test-app.js";

function createGuestDoctorApp(): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    c.set("guestId", "guest-1");
    await next();
  });
  app.route("/api/web/servers", serversRoutes);
  return app;
}

describe("web servers/doctor", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex.example.com";
    runServerDoctorMock.mockResolvedValue({
      status: "ready",
      target: {
        kind: "http",
        scope: "hosted",
        label: "Server",
      },
      checks: {
        probe: { status: "ok", detail: "ok" },
        connection: { status: "ok", detail: "ok" },
        initialization: { status: "ok", detail: "ok" },
        capabilities: { status: "ok", detail: "ok" },
        tools: { status: "ok", detail: "ok" },
        resources: { status: "ok", detail: "ok" },
        resourceTemplates: { status: "ok", detail: "ok" },
        prompts: { status: "ok", detail: "ok" },
      },
      connection: { status: "connected", detail: "ok" },
      probe: null,
      initInfo: null,
      capabilities: null,
      tools: [],
      toolsMetadata: {},
      resources: [],
      resourceTemplates: [],
      prompts: [],
      error: null,
      generatedAt: "2026-04-11T00:00:00.000Z",
    });
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
              headers: { "X-Test": "yes" },
              useOAuth: true,
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

  it("runs hosted doctor through the shared SDK workflow", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).mcpClientManager = {};
      await next();
    });
    app.route("/api/web", webRoutes);

    const response = await postJson(
      app,
      "/api/web/servers/doctor",
      {
        workspaceId: "workspace-1",
        serverId: "srv-1",
        serverName: "Example",
        oauthAccessToken: "oauth-token",
      },
      "test-token",
    );

    const { status, data } = await expectJson<{ status: string }>(response);

    expect(status).toBe(200);
    expect(data.status).toBe("ready");
    expect(runServerDoctorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          url: "https://server.example.com/mcp",
          requestInit: {
            headers: {
              "X-Test": "yes",
              Authorization: "Bearer oauth-token",
            },
          },
          capabilities: undefined,
          timeout: expect.any(Number),
        }),
        target: expect.objectContaining({
          scope: "hosted",
          workspaceId: "workspace-1",
          serverId: "srv-1",
          label: "Example",
          url: "https://server.example.com/mcp",
        }),
      }),
    );
  });

  it("prefers the backend-issued oauthAccessToken when the request does not provide one", async () => {
    global.fetch = vi.fn(async (input) => {
      if (String(input).endsWith("/web/authorize")) {
        return new Response(
          JSON.stringify({
            authorized: true,
            role: "member",
            accessLevel: "workspace_member",
            oauthAccessToken: "durable-token",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://server.example.com/mcp",
              headers: { "X-Test": "yes" },
              useOAuth: true,
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

    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).mcpClientManager = {};
      await next();
    });
    app.route("/api/web", webRoutes);

    const response = await postJson(
      app,
      "/api/web/servers/doctor",
      {
        workspaceId: "workspace-1",
        serverId: "srv-1",
        serverName: "Example",
      },
      "test-token",
    );

    const { status } = await expectJson<{ status: string }>(response);

    expect(status).toBe(200);
    expect(runServerDoctorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          requestInit: {
            headers: {
              "X-Test": "yes",
              Authorization: "Bearer durable-token",
            },
          },
        }),
      }),
    );
  });

  it("runs guest doctor through the shared SDK workflow", async () => {
    const app = createGuestDoctorApp();

    const response = await postJson(app, "/api/web/servers/doctor", {
      serverUrl: "https://guest.example.com/mcp",
      serverName: "Guest Server",
      serverHeaders: {
        "X-Guest": "yes",
      },
      oauthAccessToken: "guest-oauth-token",
    });

    const { status, data } = await expectJson<{ status: string }>(response);

    expect(status).toBe(200);
    expect(data.status).toBe("ready");
    expect(runServerDoctorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          url: "https://guest.example.com/mcp",
          requestInit: {
            headers: {
              "X-Guest": "yes",
              Authorization: "Bearer guest-oauth-token",
            },
          },
          timeout: expect.any(Number),
        }),
        target: expect.objectContaining({
          scope: "guest",
          label: "Guest Server",
          url: "https://guest.example.com/mcp",
        }),
      }),
    );
  });
});
