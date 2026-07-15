import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { streamWebChatTurnMock, disconnectAllServersMock, listToolsMock } =
  vi.hoisted(() => ({
    streamWebChatTurnMock: vi.fn(),
    disconnectAllServersMock: vi.fn(),
    listToolsMock: vi.fn(async (_serverId?: unknown) => ({ tools: [] })),
  }));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: disconnectAllServersMock,
      listTools: listToolsMock,
    })),
  };
});

vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: streamWebChatTurnMock,
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

// NOTE: chat-v2-orchestration is NOT mocked — the point of this suite is the
// real `validateUiToolEntries` boundary on the agent route.
import { createWebTestApp, postJson, expectJson } from "./helpers/test-app.js";

const BASE_BODY = {
  messages: [{ role: "user", content: "open the playground" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
  chatSessionId: "agent-session-1",
  projectId: "project-1",
};

const VALID_UI_TOOL = {
  name: "ui_navigate",
  description: "Navigate the MCPJam inspector to a page",
  inputSchema: { type: "object", properties: { target: { type: "string" } } },
  readOnly: false,
};

describe("web routes — mcpjam-agent uiTools boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamWebChatTurnMock.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  it("validates and threads uiTools into the prepare inputs", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/mcpjam-agent",
      { ...BASE_BODY, uiTools: [VALID_UI_TOOL] },
      token
    );

    expect(response.status).toBe(200);
    expect(streamWebChatTurnMock).toHaveBeenCalledTimes(1);
    const args = streamWebChatTurnMock.mock.calls[0][0];
    expect(args.prepare.uiTools).toEqual([VALID_UI_TOOL]);
  });

  it("normalizes an absent uiTools field to an empty list", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(app, "/api/web/mcpjam-agent", BASE_BODY, token);

    expect(response.status).toBe(200);
    const args = streamWebChatTurnMock.mock.calls[0][0];
    expect(args.prepare.uiTools).toEqual([]);
  });

  it("400s on malformed uiTools entries before any streaming work", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/mcpjam-agent",
      {
        ...BASE_BODY,
        uiTools: [{ ...VALID_UI_TOOL, name: "not_a_ui_tool" }],
      },
      token
    );

    const { status, data } = await expectJson<{ error?: { message?: string } }>(
      response
    );
    expect(status).toBe(400);
    expect(JSON.stringify(data)).toContain("uiTools[0].name");
    expect(streamWebChatTurnMock).not.toHaveBeenCalled();
  });

  it("still ignores appTools / selectedServerIds — this surface owns its MCP tool set", async () => {
    const { app, token } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/mcpjam-agent",
      {
        ...BASE_BODY,
        appTools: [{ alias: "app_abcd1234", appName: "X" }],
        selectedServerIds: ["srv-1", "srv-2"],
      },
      token
    );

    expect(response.status).toBe(200);
    const args = streamWebChatTurnMock.mock.calls[0][0];
    expect(args.prepare.appTools).toBeUndefined();
    // Both first-party servers pass the preflight under the mock; the
    // client-supplied ids are still ignored.
    expect(args.prepare.selectedServerIds).toEqual([
      "mcpjam-docs",
      "mcpjam-platform",
    ]);
  });
});
