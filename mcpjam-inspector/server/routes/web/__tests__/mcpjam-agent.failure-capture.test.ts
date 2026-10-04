/**
 * Ask MCPJam's route-level failures reach Sentry, classified: the turn's own
 * throws, and our docs server failing its preflight. The protocol docs server
 * is a third party's, and its preflight degrading the turn is not ours.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { streamWebChatTurnMock, listToolsMock } = vi.hoisted(() => ({
  streamWebChatTurnMock: vi.fn(),
  listToolsMock: vi.fn(async (_serverId?: unknown) => ({ tools: [] })),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: vi.fn(),
      listTools: listToolsMock,
    })),
  };
});

vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: streamWebChatTurnMock,
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import * as Sentry from "@sentry/node";
import { createWebTestApp, postJson } from "./helpers/test-app.js";
import { WebRouteError, ErrorCode } from "../errors.js";
import { MCPJAM_AGENT_FAILURE_CAPTURE } from "../../../utils/agent-failure-capture.js";

const captureException = vi.mocked(Sentry.captureException);

const BODY = {
  messages: [{ role: "user", content: "hi" }],
  model: { id: "openai/gpt-5.6-luna", provider: "openai", name: "Luna" },
  chatSessionId: "agent-session-1",
  projectId: "project-1",
};

async function post() {
  const { app, token } = createWebTestApp();
  return postJson(app, "/api/web/mcpjam-agent", BODY, token);
}

function context(index = 0) {
  return captureException.mock.calls[index]?.[1] as {
    tags: Record<string, string>;
    fingerprint?: string[];
    level?: string;
  };
}

describe("mcpjam-agent route failure capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listToolsMock.mockImplementation(async () => ({ tools: [] }));
    streamWebChatTurnMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
  });

  it("gives every turn the agent's capture rule", async () => {
    await post();
    const args = streamWebChatTurnMock.mock.calls[0]![0];
    expect(args.runtime.failureCapture).toBe(MCPJAM_AGENT_FAILURE_CAPTURE);
  });

  it("captures our docs server failing preflight: warning, incident", async () => {
    listToolsMock.mockImplementation(async (serverId?: unknown) => {
      if (serverId === "mcpjam-docs") throw new Error("docs unreachable");
      return { tools: [] };
    });

    const response = await post();

    expect(response.status).toBe(200);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(context().level).toBe("warning");
    expect(context().tags).toMatchObject({
      surface: "mcpjam_agent",
      page_class: "incident",
    });
    expect(context().fingerprint).toContain("server:mcpjam-docs");
  });

  it("does not capture the protocol docs server failing preflight", async () => {
    listToolsMock.mockImplementation(async (serverId?: unknown) => {
      if (serverId === "mcp-spec") throw new Error("upstream unreachable");
      return { tools: [] };
    });
    await post();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures a turn that throws before streaming, whatever its origin", async () => {
    streamWebChatTurnMock.mockRejectedValue(
      new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "Server missing CONVEX_HTTP_URL configuration",
      ),
    );

    const response = await post();

    expect(response.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(context().tags).toMatchObject({
      surface: "mcpjam_agent",
      page_class: "incident",
    });
  });

  it("captures a deliberate 4xx the origin policy would decline, as routine", async () => {
    streamWebChatTurnMock.mockRejectedValue(
      new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "bad history"),
    );

    const response = await post();

    expect(response.status).toBe(400);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(context().tags.page_class).toBe("routine");
    expect(context().level).toBe("warning");
  });
});
