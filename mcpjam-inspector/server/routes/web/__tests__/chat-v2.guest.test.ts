import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  disconnectAllServersMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@mcpjam/sdk", () => ({
  isMCPAuthError: vi.fn().mockReturnValue(false),
  MCPClientManager: vi.fn().mockImplementation(() => ({
    disconnectAllServers: disconnectAllServersMock,
  })),
}));

vi.mock("../../../utils/chat-v2-orchestration.js", () => ({
  prepareChatV2: prepareChatV2Mock,
}));

vi.mock("../../../utils/mcpjam-stream-handler.js", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
}));

vi.mock("@/shared/types", async () => {
  const actual = await vi.importActual<typeof import("@/shared/types")>(
    "@/shared/types",
  );
  return {
    ...actual,
    isMCPJamProvidedModel: vi.fn().mockReturnValue(true),
  };
});

import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";
import {
  initGuestTokenSecret,
  issueGuestToken,
} from "../../../services/guest-token.js";

describe("web routes — chat-v2 guest mode", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    initGuestTokenSecret();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.7,
      scrubMessages: (messages: unknown) => messages,
    });
    handleMCPJamFreeChatModelMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    disconnectAllServersMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("returns 401 when a non-guest bearer token reaches the guest branch", async () => {
    const { app } = createWebTestApp();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
      },
      "non-guest-token",
    );

    const { status, data } = await expectJson<{ code: string; message: string }>(
      response,
    );
    expect(status).toBe(401);
    expect(data.code).toBe("UNAUTHORIZED");
    expect(data.message).toContain("Valid guest token required");
  });

  it("streams hosted guest chat when a valid guest token is present", async () => {
    const { app } = createWebTestApp();
    const { token } = issueGuestToken();

    const response = await postJson(
      app,
      "/api/web/chat-v2",
      {
        messages: [{ role: "user", parts: [{ type: "text", text: "hey" }] }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
        systemPrompt: "You are helpful",
        temperature: 0.7,
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedServers: [],
        requireToolApproval: undefined,
      }),
    );
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "anthropic/claude-haiku-4.5",
        authHeader: `Bearer ${token}`,
        selectedServers: [],
      }),
    );
  });
});
