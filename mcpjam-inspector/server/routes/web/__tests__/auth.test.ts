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
      workspaceId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for tools/execute without bearer token", async () => {
    const res = await postJson(app, "/api/web/tools/execute", {
      workspaceId: "ws-1",
      serverId: "srv-1",
      toolName: "echo",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for resources/list without bearer token", async () => {
    const res = await postJson(app, "/api/web/resources/list", {
      workspaceId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for resources/read without bearer token", async () => {
    const res = await postJson(app, "/api/web/resources/read", {
      workspaceId: "ws-1",
      serverId: "srv-1",
      uri: "file:///test.txt",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for prompts/list without bearer token", async () => {
    const res = await postJson(app, "/api/web/prompts/list", {
      workspaceId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for export/server without bearer token", async () => {
    const res = await postJson(app, "/api/web/export/server", {
      workspaceId: "ws-1",
      serverId: "srv-1",
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for chat-v2 without bearer token", async () => {
    const res = await postJson(app, "/api/web/chat-v2", {
      workspaceId: "ws-1",
      selectedServerIds: ["srv-1"],
      messages: [{ role: "user", content: "hi" }],
    });
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for mcp-apps/widget-content without bearer token", async () => {
    const res = await postJson(app, "/api/web/apps/mcp-apps/widget-content", {
      workspaceId: "ws-1",
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

  it("returns 401 for chatgpt-apps/widget-content without bearer token", async () => {
    const res = await postJson(
      app,
      "/api/web/apps/chatgpt-apps/widget-content",
      {
        workspaceId: "ws-1",
        serverId: "srv-1",
        uri: "ui://widget/index.html",
        toolInput: {},
        toolId: "tool-1",
        toolName: "create_view",
      },
    );
    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
  });

  it("keeps mcp-apps sandbox-proxy public without bearer token", async () => {
    const res = await getJson(app, "/api/web/apps/mcp-apps/sandbox-proxy");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 400 for tools/list with missing required fields", async () => {
    const res = await postJson(
      app,
      "/api/web/tools/list",
      { workspaceId: "ws-1" }, // missing serverId
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
      { workspaceId: "ws-1" }, // missing serverId
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
        workspaceId: "ws-1",
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
