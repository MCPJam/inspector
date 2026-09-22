import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  prepareChatV2Mock,
  handleMCPJamFreeChatModelMock,
  fetchHostRuntimeConfigMock,
  getProductionGuestAuthHeaderMock,
  checkHarnessRuntimeAvailableMock,
  verifyAuthKitTokenMock,
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
  verifyAuthKitTokenMock: vi.fn(),
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

// Only `checkHarnessRuntimeAvailable` is stubbed. Spreading `actual` is
// load-bearing, not tidiness: a wholesale replacement makes every OTHER export
// the route calls `undefined(...)` at runtime — a 500 that looks like a routing
// bug rather than a missing mock entry.
vi.mock("../../../utils/harness/harness-availability.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/harness/harness-availability.js")
  >("../../../utils/harness/harness-availability.js");
  return {
    ...actual,
    checkHarnessRuntimeAvailable: checkHarnessRuntimeAvailableMock,
  };
});

vi.mock("../../../utils/built-in-tools/registry.js", () => ({
  resolveHostTools: resolveHostToolsMock,
}));

// The bearer verifier a `local-native` body makes the route run. Spread
// `actual` so the error CLASSES stay real — the route distinguishes an
// unverifiable session (401) from a deployment with no AuthKit (503) by
// `instanceof`, and a stubbed class would collapse the two.
// `LOCAL_HARNESS_ENABLED` is read from the environment when `config.ts` is
// first imported, which happens while this file's own imports resolve — so a
// `process.env` write in `beforeEach` would be too late to matter.
vi.mock("../../../config", async () => {
  const actual =
    await vi.importActual<typeof import("../../../config")>("../../../config");
  return { ...actual, LOCAL_HARNESS_ENABLED: true, HOSTED_MODE: false };
});

vi.mock("../../../services/authkit-jwt.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/authkit-jwt.js")
  >("../../../services/authkit-jwt.js");
  return { ...actual, verifyAuthKitToken: verifyAuthKitTokenMock };
});

import chatV2 from "../chat-v2.js";
import {
  AuthKitConfigError,
  AuthKitVerificationError,
} from "../../../services/authkit-jwt.js";
import { canonicalLocalHarnessUserId } from "../../../utils/harness/local/acting-user.js";

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

  /**
   * A LOCAL-NATIVE turn: the one class of request on this route that has to
   * establish WHO is asking before anything else happens.
   *
   * The shipped bug was structural rather than subtle — the route called the
   * target parser with no acting user at all, and the parser then read
   * `.length` off `undefined`. So every case below is about the identity: that
   * one is resolved, that it is the SAME one consent binds, that an
   * unverifiable session is refused as an authentication problem rather than a
   * malformed body, and that none of this touches an ordinary turn.
   */
  describe("local-native execution target", () => {
    const LOCAL_TARGET = {
      kind: "local-native",
      workspaceGrantId: "ws_abc123",
      runtimeId: "rt_deadbeef",
      machineId: "mach_abcdef0123456789",
      permissionProfile: "workspace-edits",
      policyVersion: "local-policy-1",
    };

    const postLocalTurn = async (overrides?: {
      headers?: Record<string, string>;
      harnessTarget?: unknown;
    }) => {
      const app = createApp();
      return await app.request("/api/mcp/chat-v2", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer authkit-session-token",
          "x-mcpjam-local-harness-grant": "grant-capability-value",
          ...(overrides?.headers ?? {}),
        },
        body: JSON.stringify({
          projectId: "project-1",
          hostId: "host-claude",
          selectedServers: ["server-1"],
          selectedServerIds: ["server-id-1"],
          messages: [{ role: "user", content: "pwd" }],
          model: {
            id: "anthropic/claude-haiku-4.5",
            provider: "anthropic",
            name: "Claude Haiku 4.5",
          },
          harnessTarget:
            "harnessTarget" in (overrides ?? {})
              ? overrides!.harnessTarget
              : LOCAL_TARGET,
        }),
      });
    };

    it("threads the target through, bound to the VERIFIED subject", async () => {
      verifyAuthKitTokenMock.mockResolvedValue({ sub: "user_01ABC" });

      const response = await postLocalTurn();

      expect(response.status).toBe(200);
      expect(verifyAuthKitTokenMock).toHaveBeenCalledWith(
        "authkit-session-token",
      );
      const engineArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
      expect(engineArgs.harnessExecutionTarget).toMatchObject({
        kind: "local-native",
        workspaceGrantId: "ws_abc123",
        runtimeId: "rt_deadbeef",
        grantToken: "grant-capability-value",
      });
    });

    it("binds the SAME canonical id the consent route would have bound", async () => {
      // The whole point of `acting-user.ts`. If these two ever disagree, the
      // grant-binding check is comparing a value to a different value and
      // every local turn fails — or, worse, stops comparing anything real.
      verifyAuthKitTokenMock.mockResolvedValue({ sub: "user_01ABC" });

      await postLocalTurn();

      const engineArgs = handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0];
      expect(engineArgs.harnessExecutionTarget.actingUserId).toBe(
        canonicalLocalHarnessUserId("user_01ABC"),
      );
    });

    it("401s an unverifiable bearer instead of running the turn", async () => {
      verifyAuthKitTokenMock.mockRejectedValue(
        new AuthKitVerificationError("bad signature"),
      );

      const response = await postLocalTurn();

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "unverified" });
      expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    });

    it("401s a local ask carrying no session at all", async () => {
      const response = await postLocalTurn({ headers: { Authorization: "" } });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        reason: "unauthenticated",
      });
      expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    });

    it("503s a deployment with no AuthKit, as the operator problem it is", async () => {
      verifyAuthKitTokenMock.mockRejectedValue(
        new AuthKitConfigError("WORKOS_CLIENT_ID is not configured"),
      );

      const response = await postLocalTurn();

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        reason: "auth-unconfigured",
      });
    });

    it("400s an incomplete target, distinctly from an auth failure", async () => {
      verifyAuthKitTokenMock.mockResolvedValue({ sub: "user_01ABC" });

      const response = await postLocalTurn({
        harnessTarget: { ...LOCAL_TARGET, runtimeId: undefined },
      });

      expect(response.status).toBe(400);
      expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    });

    it("refuses — never 500s — a session that names no member", async () => {
      // The regression, at the route: an identity the route could not resolve
      // used to reach the parser as `undefined` and die there with a
      // TypeError. Whatever the reason a subject is unusable, the answer is a
      // refusal the caller can act on and a turn that did not run.
      verifyAuthKitTokenMock.mockResolvedValue({ sub: "" });

      const response = await postLocalTurn();

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "unverified" });
      expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
    });

    it("does not verify a bearer for an ordinary hosted turn", async () => {
      // The verification is scoped to an explicit local ask. Every other turn
      // on this route — anonymous desktop, guest, BYOK — must authenticate
      // exactly as it did before.
      await postLocalTurn({ harnessTarget: undefined });

      expect(verifyAuthKitTokenMock).not.toHaveBeenCalled();
      expect(handleMCPJamFreeChatModelMock).toHaveBeenCalled();
      expect(
        handleMCPJamFreeChatModelMock.mock.calls.at(-1)![0]
          .harnessExecutionTarget,
      ).toBeUndefined();
    });

    it("exempts a local turn from the computers-data-plane requirement", async () => {
      verifyAuthKitTokenMock.mockResolvedValue({ sub: "user_01ABC" });

      await postLocalTurn();

      expect(checkHarnessRuntimeAvailableMock).toHaveBeenCalledWith(
        expect.objectContaining({ localExecution: true }),
      );
    });
  });

  it("503s a non-catalog model on a brokered harness host (model-not-hosted)", async () => {
    // The routing half of the same story: an org-BYOK model that is not in the
    // hosted catalog cannot run the real runtime, local or otherwise, and the
    // preflight says so rather than the turn failing later.
    checkHarnessRuntimeAvailableMock.mockReturnValue({
      ok: false,
      kind: "model-not-hosted",
      reason:
        "the claude-code harness only runs MCPJam-provided models — pick one " +
        "on this host to run the real runtime",
    });

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
        messages: [{ role: "user", content: "hello" }],
        model: {
          id: "org-byok/some-private-model",
          provider: "openai",
          name: "Private",
        },
      }),
    });

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/MCPJam-provided models/);
    expect(handleMCPJamFreeChatModelMock).not.toHaveBeenCalled();
  });
});
