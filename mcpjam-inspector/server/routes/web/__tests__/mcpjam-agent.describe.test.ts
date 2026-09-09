import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  streamWebChatTurnMock,
  disconnectAllServersMock,
  listToolsMock,
  managerConfigs,
} = vi.hoisted(() => ({
  streamWebChatTurnMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  listToolsMock: vi.fn(async (_serverId?: unknown) => ({ tools: [] })),
  managerConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk",
  );
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation((configs: any) => {
      managerConfigs.push(configs);
      return {
        disconnectAllServers: disconnectAllServersMock,
        listTools: listToolsMock,
      };
    }),
  };
});

vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: streamWebChatTurnMock,
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

import { createWebTestApp, postJson } from "./helpers/test-app.js";

const BASE_BODY = {
  messages: [{ role: "user", content: "show me my servers" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
  chatSessionId: "agent-session-1",
  projectId: "project-1",
};

const evalScope = {
  kind: "evals",
  version: 1,
  id: "scope",
  projectId: "project-1",
  suiteId: "suite",
  suiteName: "Suite",
  caseId: "draft:describe",
};
beforeEach(() => {
  vi.clearAllMocks();
  streamWebChatTurnMock.mockResolvedValue(new Response("ok"));
});
it.each([undefined, { ...evalScope, caseId: undefined }])(
  "rejects general and suite-level chat before model execution",
  async (scope) => {
    const { app, token } = createWebTestApp();
    const response = await postJson(
      app,
      "/api/web/mcpjam-agent",
      { ...BASE_BODY, evalScope: scope },
      token,
    );
    expect(response.status).toBe(400);
    expect(streamWebChatTurnMock).not.toHaveBeenCalled();
  },
);
it("filters Describe capabilities and excludes server tools", async () => {
  const { app, token } = createWebTestApp();
  const names = [
    "ui_eval_context",
    "ui_eval_question",
    "ui_eval_propose_cases",
    "ui_eval_edit_case",
    "ui_eval_run_suite",
    "ui_navigate",
  ];
  const response = await postJson(
    app,
    "/api/web/mcpjam-agent",
    {
      ...BASE_BODY,
      evalScope,
      uiTools: names.map((name) => ({
        name,
        description: "Test tool",
        readOnly: true,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      })),
    },
    token,
  );
  expect(response.status).toBe(200);
  const args = streamWebChatTurnMock.mock.calls[0][0];
  expect(args.prepare.uiTools.map((t: { name: string }) => t.name)).toEqual(
    names.slice(0, 3),
  );
  expect(args.prepare.selectedServerIds).toEqual([]);
  expect(args.prepare.builtInTools).toBeUndefined();
});
