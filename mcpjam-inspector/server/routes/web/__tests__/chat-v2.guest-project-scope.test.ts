import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * MJ-013 on the route the finding names, `POST /api/web/chat-v2`.
 *
 * A turn with no selected servers never reached `/web/authorize-batch`, which
 * is where project membership is checked, so a guest token ran a hosted
 * completion against any `projectId`. The same token and id got
 * `403 Not a member of this project` from `/api/web/tools/list`. A guest's
 * non-scenario turn now asks `/web/authorize-project` first and carries the
 * backend's refusal through unchanged.
 */

const {
  validateGuestTokenDetailedAsyncMock,
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchScenarioRuntimeConfigMock,
} = vi.hoisted(() => ({
  validateGuestTokenDetailedAsyncMock: vi.fn(),
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchScenarioRuntimeConfigMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenDetailedAsyncMock,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: vi.fn(),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    })),
  };
});

vi.mock("../../../utils/chat-v2-orchestration.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-v2-orchestration.js")
  >("../../../utils/chat-v2-orchestration.js");
  return { ...actual, prepareChatV2: prepareChatV2Mock };
});

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
  warnIfChatAbortSignalMissing: () => {},
}));

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-ingestion.js")
  >("../../../utils/chat-ingestion.js");
  return {
    ...actual,
    persistChatSessionToConvex: vi.fn(),
    pickEnrichmentHeaders: vi.fn(() => ({})),
  };
});

vi.mock("../../../utils/scenario-runtime-config.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/scenario-runtime-config.js")
  >("../../../utils/scenario-runtime-config.js");
  return {
    ...actual,
    fetchScenarioRuntimeConfig: fetchScenarioRuntimeConfigMock,
  };
});

vi.mock("../apps.js", () => ({ default: new Hono() }));

vi.mock("@/shared/types", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/types")>("@/shared/types");
  return { ...actual, isMCPJamProvidedModel: vi.fn().mockReturnValue(true) };
});

import { createWebTestApp, postJson } from "./helpers/test-app.js";

// The project id from the finding's reproduction.
const FOREIGN_PROJECT_ID = "v97b52s8zxg9jdhxvdfwdv57pn8d2r8v";
const GUEST_BEARER = "guest-jwt";
const MEMBER_BEARER = "member-jwt";
const AUTHORIZE_PROJECT_URL =
  "https://example.convex.site/web/authorize-project";

function turn(projectId: string, extra: Record<string, unknown> = {}) {
  return {
    projectId,
    selectedServerIds: [],
    messages: [{ role: "user", content: "go" }],
    model: {
      id: "anthropic/claude-haiku-4.5",
      provider: "anthropic",
      name: "Claude Haiku 4.5",
    },
    ...extra,
  };
}

function authorizeProjectCalls(): unknown[][] {
  return vi
    .mocked(global.fetch)
    .mock.calls.filter(([input]) => String(input) === AUTHORIZE_PROJECT_URL);
}

describe("web routes — chat-v2 guest project scope (MJ-013)", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  let authorizeProjectResponse: () => Response;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    validateGuestTokenDetailedAsyncMock.mockImplementation(
      async (token: string) =>
        token === GUEST_BEARER
          ? { valid: true, guestId: "guest-1" }
          : { valid: false, reason: "not_guest" },
    );
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
    });
    fetchScenarioRuntimeConfigMock.mockResolvedValue({ ok: true, config: {} });
    handleMCPJamFreeChatModelMock.mockImplementation(async (options) => {
      options.onStreamComplete?.();
      return new Response("ok", { status: 200 });
    });
    authorizeProjectResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    global.fetch = vi.fn(async (input) => {
      if (String(input) === AUTHORIZE_PROJECT_URL) {
        return authorizeProjectResponse();
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("refuses a guest on a project it is not a member of with the MCP routes' 403", async () => {
    authorizeProjectResponse = () =>
      new Response(
        JSON.stringify({
          code: "FORBIDDEN",
          message: "Not a member of this project",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      turn(FOREIGN_PROJECT_ID),
      GUEST_BEARER,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "Not a member of this project",
    });
    expect(authorizeProjectCalls()).toEqual([
      [
        AUTHORIZE_PROJECT_URL,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ projectId: FOREIGN_PROJECT_ID }),
        }),
      ],
    ]);
    expect(prepareChatV2Mock).not.toHaveBeenCalled();
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("fails closed when the backend does not serve the route yet", async () => {
    authorizeProjectResponse = () =>
      new Response("No matching routes found", { status: 404 });
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      turn(FOREIGN_PROJECT_ID),
      GUEST_BEARER,
    );

    expect(response.status).toBe(404);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });

  it("runs a guest's turn in its own project", async () => {
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      turn("guest-project-1"),
      GUEST_BEARER,
    );

    expect(response.status).toBe(200);
    expect(authorizeProjectCalls()).toHaveLength(1);
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "guest-project-1" }),
    );
  });

  it("leaves a guest's scenario turn to the scenario grant", async () => {
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      turn("host-project-1", {
        scenarioId: "cbx_shared",
        accessVersion: 1,
        surface: "share_link",
      }),
      GUEST_BEARER,
    );

    expect(response.status).toBe(200);
    expect(authorizeProjectCalls()).toHaveLength(0);
    expect(fetchScenarioRuntimeConfigMock).toHaveBeenCalled();
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "host-project-1",
        scenarioId: "cbx_shared",
      }),
    );
  });

  it("does not add the check to a signed-in member's turn", async () => {
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      turn("project-1"),
      MEMBER_BEARER,
    );

    expect(response.status).toBe(200);
    expect(authorizeProjectCalls()).toHaveLength(0);
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
    );
  });
});
