import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// The companion endpoint under test proxies a `resources/read` to the
// platform MCP worker — the heavy chat-turn machinery the route module also
// imports is irrelevant here.
vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: vi.fn(),
}));

// Capture MCPClientManager construction (server configs, notably the
// forwarded bearer) and stub readResource. Everything else from @mcpjam/sdk
// stays real (MCP_UI_EXTENSION_ID etc. are imported at module load).
const managerState = vi.hoisted(() => ({
  constructedConfigs: [] as Record<string, any>[],
  readResource: vi.fn(),
  disconnectAllServers: vi.fn(async () => {}),
}));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  class FakeMCPClientManager {
    constructor(configs: Record<string, any>) {
      managerState.constructedConfigs.push(configs);
    }
    readResource = managerState.readResource;
    disconnectAllServers = managerState.disconnectAllServers;
    listTools = vi.fn();
  }
  return { ...actual, MCPClientManager: FakeMCPClientManager };
});

vi.mock("../auth.js", () => {
  class WebRouteError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    WebRouteError,
    assertBearerToken: (c: any) => {
      const header = c.req.header("authorization");
      if (!header) {
        throw new WebRouteError(401, "UNAUTHORIZED", "Missing bearer token");
      }
      return header.replace(/^Bearer\s+/i, "");
    },
    readJsonBody: async (c: any) => await c.req.json(),
    parseWithSchema: (schema: any, body: unknown) => {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new WebRouteError(400, "VALIDATION_ERROR", parsed.error.message);
      }
      return parsed.data;
    },
    ErrorCode: new Proxy({}, { get: (_target, key) => String(key) }),
    webError: (c: any, status: number, code: string, message: string) =>
      c.json({ error: { code, message } }, status),
    mapRuntimeError: (error: any) => ({
      status: typeof error?.status === "number" ? error.status : 500,
      code: error?.code ?? "INTERNAL_ERROR",
      message: error?.message ?? "Internal error",
      details: error?.details,
    }),
  };
});

import mcpjamAgent from "../mcpjam-agent.js";
import {
  MCPJAM_PLATFORM_SERVER_ID,
  MCPJAM_AGENT_WIDGET_CONTENT_PATH,
} from "../../../../shared/mcpjam-agent-widgets";

const SHOW_SERVERS_URI = "ui://mcpjam/show-servers.html";

function makeApp() {
  const app = new Hono();
  app.route("/api/web/mcpjam-agent", mcpjamAgent);
  return app;
}

const VALID_BODY = {
  resourceUri: SHOW_SERVERS_URI,
  toolId: "call_1",
  toolName: "show_servers",
  toolInput: {},
};

function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request(MCPJAM_AGENT_WIDGET_CONTENT_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  managerState.constructedConfigs.length = 0;
  managerState.readResource.mockReset();
  managerState.disconnectAllServers.mockClear();
});

describe("POST /api/web/mcpjam-agent/widget-content", () => {
  it("reads the ui:// resource from the platform worker with the caller's bearer", async () => {
    managerState.readResource.mockResolvedValue({
      contents: [
        {
          uri: SHOW_SERVERS_URI,
          mimeType: "text/html;profile=mcp-app",
          text: "<html>WIDGET</html>",
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    });

    const app = makeApp();
    const response = await post(app, VALID_BODY, {
      authorization: "Bearer user-token",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.html).toBe("<html>WIDGET</html>");
    expect(body.prefersBorder).toBe(true);
    expect(body.mimeType).toBe("text/html;profile=mcp-app");
    expect(body.mimeTypeValid).toBe(true);

    // The ephemeral connection targets the platform server id with the
    // caller's own bearer as the MCP access token.
    expect(managerState.constructedConfigs).toHaveLength(1);
    const config =
      managerState.constructedConfigs[0]![MCPJAM_PLATFORM_SERVER_ID];
    expect(config).toBeDefined();
    expect(config.accessToken).toBe("user-token");
    expect(managerState.readResource).toHaveBeenCalledWith(
      MCPJAM_PLATFORM_SERVER_ID,
      { uri: SHOW_SERVERS_URI }
    );
    expect(managerState.disconnectAllServers).toHaveBeenCalled();
  });

  it("rejects non-ui:// resource URIs", async () => {
    const app = makeApp();
    const response = await post(
      app,
      { ...VALID_BODY, resourceUri: "https://evil.example/page.html" },
      { authorization: "Bearer user-token" }
    );
    expect(response.status).toBe(400);
    expect(managerState.readResource).not.toHaveBeenCalled();
  });

  it("requires a bearer token", async () => {
    const app = makeApp();
    const response = await post(app, VALID_BODY);
    expect(response.status).toBe(401);
  });

  it("returns 404 when the resource has no content", async () => {
    managerState.readResource.mockResolvedValue({ contents: [] });
    const app = makeApp();
    const response = await post(app, VALID_BODY, {
      authorization: "Bearer user-token",
    });
    expect(response.status).toBe(404);
  });

  it("maps worker failures through the standard error envelope and disconnects", async () => {
    managerState.readResource.mockRejectedValue(new Error("worker down"));
    const app = makeApp();
    const response = await post(app, VALID_BODY, {
      authorization: "Bearer user-token",
    });
    expect(response.status).toBe(500);
    expect(managerState.disconnectAllServers).toHaveBeenCalled();
  });
});
