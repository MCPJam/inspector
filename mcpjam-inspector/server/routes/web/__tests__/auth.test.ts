import { describe, it, expect } from "vitest";
import {
  createWebTestApp,
  getJson,
  postJson,
  expectJson,
} from "./helpers/test-app.js";

describe("web routes — auth enforcement", () => {
  const { app, token } = createWebTestApp();

  it("returns 401 for tools/list without bearer token", async () => {
    const res = await postJson(app, "/api/web/tools/list", {
      projectId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for tools/execute without bearer token", async () => {
    const res = await postJson(app, "/api/web/tools/execute", {
      projectId: "ws-1",
      serverId: "srv-1",
      toolName: "echo",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for resources/list without bearer token", async () => {
    const res = await postJson(app, "/api/web/resources/list", {
      projectId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for resources/read without bearer token", async () => {
    const res = await postJson(app, "/api/web/resources/read", {
      projectId: "ws-1",
      serverId: "srv-1",
      uri: "file:///test.txt",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for prompts/list without bearer token", async () => {
    const res = await postJson(app, "/api/web/prompts/list", {
      projectId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for export/server without bearer token", async () => {
    const res = await postJson(app, "/api/web/export/server", {
      projectId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for servers/doctor without bearer token", async () => {
    const res = await postJson(app, "/api/web/servers/doctor", {
      projectId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for chat-v2 without bearer token", async () => {
    const res = await postJson(app, "/api/web/chat-v2", {
      projectId: "ws-1",
      selectedServerIds: ["srv-1"],
      messages: [{ role: "user", content: "hi" }],
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for mcp-apps/widget-content without bearer token", async () => {
    const res = await postJson(app, "/api/web/apps/mcp-apps/widget-content", {
      projectId: "ws-1",
      serverId: "srv-1",
      resourceUri: "ui://widget/index.html",
      toolInput: {},
      toolId: "tool-1",
      toolName: "create_view",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("keeps mcp-apps sandbox-proxy public without bearer token", async () => {
    const res = await getJson(app, "/api/web/apps/mcp-apps/sandbox-proxy");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(body).toContain('const RECORDER_SHIM = "(function(){');
    expect(body).toContain("recorderBootstrap();");
    expect(body).not.toContain('const RECORDER_SHIM = "__MCPJAM_RECORDER_SHIM__";');
  });

  it("returns 400 for tools/list with missing required fields", async () => {
    const res = await postJson(
      app,
      "/api/web/tools/list",
      { projectId: "ws-1" }, // missing serverId
      token,
    );
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(400);
    expect(data.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for export/server with missing required fields", async () => {
    const res = await postJson(
      app,
      "/api/web/export/server",
      { projectId: "ws-1" }, // missing serverId
      token,
    );
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(400);
    expect(data.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for chat-v2 with empty messages", async () => {
    const res = await postJson(
      app,
      "/api/web/chat-v2",
      {
        projectId: "ws-1",
        selectedServerIds: ["srv-1"],
        messages: [],
        model: { id: "claude-sonnet-4-5", provider: "anthropic" },
      },
      token,
    );
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(400);
    expect(data.code).toBe("VALIDATION_ERROR");
  });
});

// The single-server/multi-server route schemas are stripping z.objects, so
// the enterprise-auth policy is deliberately read from the PRE-PARSE raw
// body in createManualHostedConnection — a route schema that forgets to
// declare xaaPolicy must not silently drop enforcement (fail-open). This
// pins the raw-body read: a schema that strips the field still 409s on a
// malformed policy.
describe("createManualHostedConnection — xaaPolicy survives schema stripping", () => {
  it("rejects a malformed policy that a stripping schema would have removed", async () => {
    const { createManualHostedConnection } = await import("../auth.js");
    const { z } = await import("zod");
    const strippingSchema = z.object({ projectId: z.string() });
    const c = {
      get: () => undefined,
      req: { header: () => "Bearer test-bearer" },
    } as any;

    let thrown: any;
    try {
      await createManualHostedConnection(
        c,
        { projectId: "proj-1", xaaPolicy: { idp: "okta" } },
        strippingSchema
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.status).toBe(409);
    expect(thrown?.details?.reason).toBe("xaa_policy_invalid");
  });
});

// Declared plugin transports (`httpVariant` on the authorize serverConfig,
// once the backend serves it): `sse` skips the Streamable HTTP attempt,
// `streamable-http` rules out the silent SSE downgrade, absence — every row
// today — leaves the config byte-identical.
describe("toHttpConfig — declared httpVariant mapping", () => {
  it("maps a declared sse transport to preferSSE", async () => {
    const { toHttpConfig } = await import("../auth.js");
    const config = toHttpConfig(
      {
        serverConfig: {
          transportType: "http",
          url: "https://sse.example.com/mcp",
          httpVariant: "sse",
        },
      },
      1000
    );
    expect(config.preferSSE).toBe(true);
    expect(config.disableSseFallback).toBeUndefined();
  });

  it("maps a declared streamable-http transport to disableSseFallback", async () => {
    const { toHttpConfig } = await import("../auth.js");
    const config = toHttpConfig(
      {
        serverConfig: {
          transportType: "http",
          url: "https://streamable.example.com/mcp",
          httpVariant: "streamable-http",
        },
      },
      1000
    );
    expect(config.disableSseFallback).toBe(true);
    expect(config.preferSSE).toBeUndefined();
  });

  it("sets neither flag when no transport was declared", async () => {
    const { toHttpConfig } = await import("../auth.js");
    const config = toHttpConfig(
      {
        serverConfig: {
          transportType: "http",
          url: "https://plain.example.com/mcp",
        },
      },
      1000
    );
    expect(config.preferSSE).toBeUndefined();
    expect(config.disableSseFallback).toBeUndefined();
  });
});
