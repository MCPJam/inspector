import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  checkHarnessRuntimeAvailableMock,
  validateAppToolEntriesMock,
  validateUiToolEntriesMock,
  validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPromptMock,
  AppToolValidationErrorMock,
  UiToolValidationErrorMock,
  WidgetModelContextValidationErrorMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  checkHarnessRuntimeAvailableMock: vi.fn(),
  validateAppToolEntriesMock: vi.fn(() => []),
  validateUiToolEntriesMock: vi.fn(() => []),
  validateWidgetModelContextEntriesMock: vi.fn(() => []),
  buildWidgetModelContextSystemPromptMock: vi.fn(() => ""),
  AppToolValidationErrorMock: class AppToolValidationError extends Error {},
  UiToolValidationErrorMock: class UiToolValidationError extends Error {},
  WidgetModelContextValidationErrorMock: class WidgetModelContextValidationError extends Error {},
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
  };
});

vi.mock("@/shared/types", async () => {
  const actual =
    await vi.importActual<typeof import("@/shared/types")>("@/shared/types");
  return {
    ...actual,
    isMCPJamProvidedModel: vi.fn().mockReturnValue(true),
    isMCPJamGuestAllowedModel: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../../../utils/chat-v2-orchestration", () => ({
  prepareChatV2: prepareChatV2Mock,
  validateAppToolEntries: validateAppToolEntriesMock,
  AppToolValidationError: AppToolValidationErrorMock,
  validateUiToolEntries: validateUiToolEntriesMock,
  UiToolValidationError: UiToolValidationErrorMock,
  validateWidgetModelContextEntries: validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPrompt: buildWidgetModelContextSystemPromptMock,
  WidgetModelContextValidationError: WidgetModelContextValidationErrorMock,
}));

vi.mock("../../../utils/mcpjam-stream-handler", () => ({
  handleMCPJamFreeChatModel: handleMCPJamFreeChatModelMock,
  warnIfChatAbortSignalMissing: () => {},
}));

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: fetchHostRuntimeConfigMock,
}));

vi.mock("../../../utils/harness/harness-availability.js", () => ({
  checkHarnessRuntimeAvailable: checkHarnessRuntimeAvailableMock,
}));

vi.mock("../../../utils/built-in-tools/registry.js", () => ({
  resolveHostTools: vi.fn(() => ({})),
}));

import chatV2 from "../chat-v2.js";

function createApp() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {
      getToolsForAiSdk: vi.fn().mockResolvedValue({}),
      getServerConfig: vi.fn(),
    };
    await next();
  });
  app.route("/api/mcp/chat-v2", chatV2);
  return app;
}

describe("POST /api/mcp/chat-v2 harness host routing", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
    fetchHostRuntimeConfigMock.mockResolvedValue({
      ok: true,
      config: {
        hostId: "host-claude",
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "host system",
        temperature: 0.2,
        requireToolApproval: false,
        respectToolVisibility: true,
        selectedServerIds: ["server-id-1"],
        harness: "claude-code",
      },
    });
    checkHarnessRuntimeAvailableMock.mockReturnValue({ ok: true });
    prepareChatV2Mock.mockResolvedValue({
      allTools: {},
      enhancedSystemPrompt: "system",
      resolvedTemperature: 0.2,
      scrubMessages: (messages: unknown) => messages,
      progressivePlan: undefined,
      discoveryState: undefined,
    });
    handleMCPJamFreeChatModelMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
  });

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
  });

  it("uses the host runtime-config harness for local Playground turns", async () => {
    const app = createApp();

    const response = await app.request("/api/mcp/chat-v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer signed-in-test-token",
      },
      body: JSON.stringify({
        projectId: "project-1",
        hostId: "host-claude",
        selectedServers: ["server-1"],
        selectedServerIds: ["server-id-1"],
        messages: [{ role: "user", content: "create empty.txt" }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(fetchHostRuntimeConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-claude" }),
    );
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "claude-code" }),
    );
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "claude-code" }),
    );
  });
});
