import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The companion endpoint under test serves static bundle HTML — the heavy
// chat-turn machinery the route module also imports is irrelevant here.
vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: vi.fn(),
}));

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
import { MCPJAM_APP_HTML } from "../../../../../mcp/src/generated/McpAppsHtml.bundled.js";
import {
  MCPJAM_PLATFORM_SERVER_ID,
  SHOW_SERVERS_RESOURCE_URI,
} from "../../../../shared/mcpjam-agent-widgets";

function makeApp() {
  const app = new Hono();
  app.route("/api/web/mcpjam-agent", mcpjamAgent);
  return app;
}

const VALID_BODY = {
  resourceUri: SHOW_SERVERS_RESOURCE_URI,
  toolId: "call_1",
  toolName: "show_servers",
  toolInput: {},
};

function post(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/web/mcpjam-agent/widget-content", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/web/mcpjam-agent/widget-content", () => {
  it("serves the platform widget bundle for a known resource URI", async () => {
    const app = makeApp();
    const response = await post(app, VALID_BODY, {
      authorization: "Bearer user-token",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.html).toBe(MCPJAM_APP_HTML);
    expect(body.prefersBorder).toBe(true);
    expect(body.mimeType).toBe("text/html;profile=mcp-app");
    expect(body.mimeTypeValid).toBe(true);
    expect(body.permissive).toBe(true);
    expect(body.cspMode).toBe("permissive");
  });

  it("rejects resource URIs outside the platform widget catalog", async () => {
    const app = makeApp();
    const response = await post(
      app,
      { ...VALID_BODY, resourceUri: "ui://evil/whatever.html" },
      { authorization: "Bearer user-token" }
    );
    expect(response.status).toBe(404);
  });

  it("requires a bearer token", async () => {
    const app = makeApp();
    const response = await post(app, VALID_BODY);
    expect(response.status).toBe(401);
  });

  it("widget tool result ids round-trip to this endpoint's routing constant", () => {
    // fetch-widget-content.ts routes on this exact id; the tool stamps it.
    expect(MCPJAM_PLATFORM_SERVER_ID).toBe("mcpjam-platform");
  });
});
