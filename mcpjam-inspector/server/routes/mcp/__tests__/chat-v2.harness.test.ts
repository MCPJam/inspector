import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  getProductionGuestAuthHeaderMock,
  checkHarnessRuntimeAvailableMock,
  resolveHostToolsMock,
  validateAppToolEntriesMock,
  validateUiToolEntriesMock,
  validatePageToolEntriesMock,
  validateWidgetModelContextEntriesMock,
  buildWidgetModelContextSystemPromptMock,
  AppToolValidationErrorMock,
  UiToolValidationErrorMock,
  PageToolValidationErrorMock,
  WidgetModelContextValidationErrorMock,
} = vi.hoisted(() => ({
  prepareChatV2Mock: vi.fn(),
  handleMCPJamFreeChatModelMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  getProductionGuestAuthHeaderMock: vi.fn(),
  checkHarnessRuntimeAvailableMock: vi.fn(),
  resolveHostToolsMock: vi.fn(() => ({})),
  validateAppToolEntriesMock: vi.fn(() => []),
  validateUiToolEntriesMock: vi.fn(() => []),
  validatePageToolEntriesMock: vi.fn(() => []),
  validateWidgetModelContextEntriesMock: vi.fn(() => []),
  buildWidgetModelContextSystemPromptMock: vi.fn(() => ""),
  AppToolValidationErrorMock: class AppToolValidationError extends Error {},
  UiToolValidationErrorMock: class UiToolValidationError extends Error {},
  PageToolValidationErrorMock: class PageToolValidationError extends Error {},
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
  // This mock replaces the module wholesale, so an export the route calls but
  // this object omits is `undefined(...)` at runtime — a 500 that looks like a
  // routing bug rather than a missing mock entry.
  validatePageToolEntries: validatePageToolEntriesMock,
  PageToolValidationError: PageToolValidationErrorMock,
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

vi.mock("../../../utils/guest-auth.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/guest-auth.js")
  >("../../../utils/guest-auth.js");
  return {
    ...actual,
    getProductionGuestAuthHeader: getProductionGuestAuthHeaderMock,
  };
});

vi.mock("../../../utils/harness/harness-availability.js", () => ({
  checkHarnessRuntimeAvailable: checkHarnessRuntimeAvailableMock,
}));

vi.mock("../../../utils/built-in-tools/registry.js", () => ({
  resolveHostTools: resolveHostToolsMock,
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
    getProductionGuestAuthHeaderMock.mockResolvedValue("Bearer guest-minted");
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

  it("routes a guest turn through the emulated engine (runtime-config omits harness/computer)", async () => {
    // COMP-3 guest-gate regression. A guest actor's server-resolved runtime
    // config OMITS `harness` and `computer` (the backend gates them behind the
    // account-scoped PHASE3 flags — see mcpjam-backend convex/lib/
    // executionAccess.ts). The route must then run the EMULATED engine: no
    // harness threaded to prepare/stream, no harness preflight, and no
    // computer-backed capability. Even a body that tries to smuggle a harness/
    // computer can't win — the resolver never reads them from the body.
    fetchHostRuntimeConfigMock.mockResolvedValueOnce({
      ok: true,
      config: {
        hostId: "host-guest",
        modelId: "anthropic/claude-haiku-4.5",
        systemPrompt: "host system",
        temperature: 0.2,
        requireToolApproval: false,
        respectToolVisibility: true,
        selectedServerIds: ["server-id-1"],
        // harness + computer intentionally omitted (guest actor).
      },
    });

    const app = createApp();

    const response = await app.request("/api/mcp/chat-v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer guest-test-token",
      },
      body: JSON.stringify({
        projectId: "project-1",
        hostId: "host-guest",
        selectedServers: ["server-1"],
        selectedServerIds: ["server-id-1"],
        messages: [{ role: "user", content: "create empty.txt" }],
        model: {
          id: "anthropic/claude-haiku-4.5",
          provider: "anthropic",
          name: "Claude Haiku 4.5",
        },
        // Tampered body: a guest tries to force the real harness + a computer.
        harness: "claude-code",
        computer: { kind: "personal" },
      }),
    });

    expect(response.status).toBe(200);
    // Emulated path: harness is never threaded into prepare or the stream.
    expect(prepareChatV2Mock).toHaveBeenCalledWith(
      expect.not.objectContaining({ harness: expect.anything() }),
    );
    expect(handleMCPJamFreeChatModelMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ harness: expect.anything() }),
    );
    // No harness ⇒ no availability preflight runs.
    expect(checkHarnessRuntimeAvailableMock).not.toHaveBeenCalled();
    // No computer capability: resolveHostTools sees `computer: undefined`
    // (sourced from the runtime config, never the tampered body).
    expect(resolveHostToolsMock).toHaveBeenCalled();
    expect(resolveHostToolsMock.mock.calls[0][0].computer).toBeUndefined();
  });

  /**
   * An EXTERNAL-ACCOUNT harness host (Cursor) on the desktop rail.
   *
   * Its model is the `cursor/auto` sentinel, deliberately NOT an MCPJam-hosted
   * model, so `isMcpJamProvidedModel` is false for it — and every "does this
   * turn take the MCPJam free path?" decision on this route used to be that one
   * boolean. Exempting only the DISPATCH left the bearer mint behind it,
   * which turned an anonymous Cursor turn into a 503 on a host the preflight
   * had just called ready.
   */
  describe("external-account harness host (cursor)", () => {
    const cursorHost = {
      ok: true,
      config: {
        hostId: "host-cursor",
        modelId: "cursor/auto",
        systemPrompt: "host system",
        requireToolApproval: false,
        selectedServerIds: ["server-id-1"],
        harness: "cursor",
      },
    };

    const postAnonymousCursorTurn = async () => {
      fetchHostRuntimeConfigMock.mockResolvedValue(cursorHost);
      const app = createApp();
      return await app.request("/api/mcp/chat-v2", {
        method: "POST",
        // NO Authorization header — the desktop inspector's ordinary state.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "project-1",
          hostId: "host-cursor",
          selectedServers: ["server-1"],
          selectedServerIds: ["server-id-1"],
          messages: [{ role: "user", content: "create empty.txt" }],
          // What the picker holds on a Cursor host: an unrelated model, since
          // the sentinel is not a selectable entry.
          model: {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            name: "Claude Haiku 4.5",
          },
        }),
      });
    };

    it("mints the guest bearer for an anonymous turn instead of 503-ing", async () => {
      const response = await postAnonymousCursorTurn();

      expect(response.status).toBe(200);
      expect(getProductionGuestAuthHeaderMock).toHaveBeenCalled();
      const engineArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
      expect(engineArgs.authHeader).toBe("Bearer guest-minted");
      // The harness ran, on the host's own sentinel — not the browser's pick.
      expect(engineArgs.harness).toBe("cursor");
      expect(engineArgs.modelId).toBe("cursor/auto");
    });

    it("surfaces the mint failure as the 503 it is, not as a silent BYOK fallthrough", async () => {
      // The bearer is genuinely required by this branch (it persists the
      // session and authenticates the box reservation), so a failed mint must
      // still refuse — the fix is about WHICH turns get one, not about running
      // without.
      getProductionGuestAuthHeaderMock.mockResolvedValue(null);

      const response = await postAnonymousCursorTurn();

      expect(response.status).toBe(503);
      expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    });
  });
});
