import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthChallengeSignal,
  ToolSecuritySchemeResolution,
} from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/state/app-types";
import {
  AUTH_CHALLENGE_DISMISSED_MESSAGE,
  connectAuthChallenge,
  clearAuthChallengeCards,
  dismissAuthChallenge,
  presentAuthChallenge,
  presentWidgetAuthChallenge,
  registerAuthChallengeHostProfile,
  settleSignInCallback,
  useAuthChallengeCardStore,
  type AuthChallengeCard,
} from "../auth-challenge-lifecycle";
import {
  claimPendingDirectScopeStepUpReplay,
  peekPendingDirectScopeStepUpReplay,
  SIGNED_IN_FOR_ANOTHER_REQUEST_MESSAGE,
  type DirectScopeStepUpReplayDescriptor,
} from "../scope-step-up-replay";
import { useAuthChallengeNoticeStore } from "../auth-challenge-chat";
import { registerScopeStepUpHostBridge } from "../scope-step-up";
import { authorizationFlowDigest } from "../oauth/flow-digest";
import { persistRequestedScopes } from "../oauth/requested-scopes";


const {
  clearOAuthDataMock,
  clearOAuthFlowStateMock,
  initiateOAuthMock,
  readStoredOAuthConfigMock,
  resolveStoredIssuerMock,
  trackMock,
} = vi.hoisted(() => ({
  clearOAuthDataMock: vi.fn(),
  clearOAuthFlowStateMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  resolveStoredIssuerMock: vi.fn(),
  trackMock: vi.fn(),
}));

const readStoredDiscoveryScopesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  clearOAuthData: clearOAuthDataMock,
  clearOAuthFlowState: clearOAuthFlowStateMock,
  hasOAuthConfig: vi.fn(),
  initiateOAuth: initiateOAuthMock,
  readStoredDiscoveryScopes: readStoredDiscoveryScopesMock,
  readStoredOAuthConfig: readStoredOAuthConfigMock,
  resolveStoredIssuer: resolveStoredIssuerMock,
}));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));


const PRM = "https://orders.example/.well-known/oauth-protected-resource/mcp";
const OPERATION = { method: "tools/call" as const, operation: "list_orders" };
const REPLAY: DirectScopeStepUpReplayDescriptor = {
  kind: "tool",
  surface: "tools",
  serverName: "orders",
  toolName: "list_orders",
  parameters: { status: "open" },
};

const server = {
  name: "orders",
  config: { type: "http", url: "https://orders.example/mcp" },
  lastConnectionTime: new Date(),
  connectionStatus: "connected",
  retryCount: 0,
  enabled: true,
} as unknown as ServerWithName;

function http401(
  overrides: Partial<AuthChallengeSignal> = {},
): AuthChallengeSignal {
  return {
    source: "http_401",
    requiredScope: "orders:read",
    resourceMetadataUrl: PRM,
    effectiveAuth: "discover",
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: true,
      hasScope: true,
      hasErrorParams: false,
    },
    ...overrides,
  };
}

function metaChallenge(
  overrides: Partial<AuthChallengeSignal> = {},
): AuthChallengeSignal {
  return {
    source: "tool_result_meta",
    error: "insufficient_scope",
    errorDescription: "You need to login to continue",
    resourceMetadataUrl: PRM,
    effectiveAuth: "discover",
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: true,
      hasScope: false,
      hasErrorParams: true,
    },
    ...overrides,
  };
}

const OAUTH2: ToolSecuritySchemeResolution = {
  schemes: [{ type: "oauth2", scopes: ["orders:read"] }],
  source: "tool",
};

async function presentCard(
  overrides: Partial<Parameters<typeof presentAuthChallenge>[0]> = {},
): Promise<AuthChallengeCard> {
  const presentation = await presentAuthChallenge({
    server,
    signal: http401(),
    surface: "tools",
    operation: OPERATION,
    readOnly: true,
    replay: REPLAY,
    ...overrides,
  });
  if (presentation.kind !== "card") {
    throw new Error(`expected a card, got ${presentation.kind}`);
  }
  return presentation.card;
}

describe("auth challenge lifecycle", () => {
  let unregisterProfile: () => void = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    useAuthChallengeCardStore.setState({ cards: {} });
    readStoredOAuthConfigMock.mockReturnValue({});
    resolveStoredIssuerMock.mockReturnValue("https://as.example");
    initiateOAuthMock.mockImplementation(async (options) => {
      await options.onAuthorizationRedirect?.({ state: "flow-1" });
      return { success: true };
    });
  });

  afterEach(() => {
    unregisterProfile();
  });

  it("leaves the caller's replay descriptor unchanged", async () => {
    const replay = { ...REPLAY };
    const card = await presentCard({ replay });
    expect(replay).not.toHaveProperty("authAttempt");
    expect(card.replay).toEqual({ ...REPLAY, authAttempt: card.attempt });
  });

  it("successful cleanup only removes the exact call's card", async () => {
    const first = await presentCard({
      replay: {
        ...REPLAY,
        authAttempt: {
          projectId: "p1",
          serverId: "orders",
          surface: "tools",
          callId: "a",
        },
      },
    });
    const other = await presentCard({
      replay: {
        ...REPLAY,
        authAttempt: {
          projectId: "p2",
          serverId: "orders",
          surface: "tools",
          callId: "b",
        },
      },
    });
    clearAuthChallengeCards(server.name, first.attempt);
    expect(
      useAuthChallengeCardStore.getState().cards[first.key],
    ).toBeUndefined();
    expect(useAuthChallengeCardStore.getState().cards[other.key]).toBeDefined();
  });

  describe("presenting", () => {
    it("shows one Connect card per server and origin, with no side effects", async () => {
      const card = await presentCard();
      expect(card).toMatchObject({
        serverName: "orders",
        serverOrigin: "https://orders.example",
        action: "prompt",
        readOnly: true,
      });
      await presentCard();
      expect(
        Object.keys(useAuthChallengeCardStore.getState().cards),
      ).toHaveLength(1);
      expect(initiateOAuthMock).not.toHaveBeenCalled();
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
      expect(
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("mcp-auth-challenge-ledger"),
        ),
      ).toEqual([]);
      expect(trackMock).toHaveBeenCalledWith(
        "auth_challenge_card_shown",
        expect.objectContaining({ source: "http_401", action: "prompt" }),
      );
    });

    it("leaves a 403 step-up to the step-up flow", async () => {
      const presentation = await presentAuthChallenge({
        server,
        signal: http401({ source: "http_403_insufficient_scope" }),
        surface: "tools",
        operation: OPERATION,
        readOnly: true,
      });
      expect(presentation).toEqual({ kind: "ignored" });
    });

    it.each(["none", "bearer", "xaa"] as const)(
      "explains instead of prompting under %s",
      async (effectiveAuth) => {
        const presentation = await presentAuthChallenge({
          server,
          signal: http401({ effectiveAuth }),
          surface: "tools",
          operation: OPERATION,
          readOnly: true,
        });
        expect(presentation).toMatchObject({
          kind: "notice",
          reason: "blocked",
        });
        expect(useAuthChallengeCardStore.getState().cards).toEqual({});
      },
    );

    it("passes a _meta challenge through by default (not in the MCP spec)", async () => {
      const presentation = await presentAuthChallenge({
        server,
        signal: metaChallenge(),
        surface: "tools",
        operation: OPERATION,
        readOnly: true,
        schemes: OAUTH2,
      });
      expect(presentation).toMatchObject({
        kind: "notice",
        reason: "passthrough",
      });
    });

    it("prompts on a _meta challenge for a host that honors it, with both halves", async () => {
      unregisterProfile = registerAuthChallengeHostProfile(() => ({
        toolResultAuthChallenge: "prompt",
      }));
      const card = await presentCard({
        signal: metaChallenge(),
        schemes: OAUTH2,
      });
      expect(card.action).toBe("prompt");

      const noOAuth2 = await presentAuthChallenge({
        server,
        signal: metaChallenge(),
        surface: "tools",
        operation: OPERATION,
        readOnly: true,
        schemes: { schemes: [{ type: "noauth" }], source: "tool" },
      });
      expect(noOAuth2).toMatchObject({ kind: "notice", reason: "passthrough" });
    });

    it("notifies (no replay) when the tool's schemes are unresolved", async () => {
      unregisterProfile = registerAuthChallengeHostProfile(() => ({
        toolResultAuthChallenge: "prompt",
      }));
      const card = await presentCard({
        signal: metaChallenge(),
        schemes: { schemes: [], source: "unresolved" },
      });
      expect(card.action).toBe("notify");
      expect(card.replay).toBeUndefined();
    });

    it("needs WWW-Authenticate: Bearer when the host's trigger says so", async () => {
      unregisterProfile = registerAuthChallengeHostProfile(() => ({
        unauthorizedChallengeTrigger: "bearer-header",
      }));
      const presentation = await presentAuthChallenge({
        server,
        signal: http401({
          facets: {
            challengeHeader: "none",
            hasResourceMetadata: false,
            hasScope: false,
            hasErrorParams: false,
          },
        }),
        surface: "tools",
        operation: OPERATION,
        readOnly: true,
      });
      expect(presentation).toMatchObject({
        kind: "notice",
        reason: "passthrough",
      });
    });

    it("remembers Not now for the session", async () => {
      const card = await presentCard();
      dismissAuthChallenge(card);
      expect(useAuthChallengeCardStore.getState().cards).toEqual({});
      const again = await presentAuthChallenge({
        server,
        signal: http401(),
        surface: "tools",
        operation: OPERATION,
        readOnly: true,
      });
      expect(again).toEqual(
        expect.objectContaining({
          kind: "notice",
          reason: "dismissed",
          message: AUTH_CHALLENGE_DISMISSED_MESSAGE,
        }),
      );
    });
  });

  describe("connecting", () => {
    it("keeps the card when a secure flow digest is unavailable", async () => {
      const card = await presentCard();
      vi.stubGlobal("crypto", { randomUUID: () => "test-call" });
      try {
        const result = await connectAuthChallenge(card, server, {
          isTrusted: true,
        });
        expect(result.kind).toBe("failed");
        expect(
          useAuthChallengeCardStore.getState().cards[card.key],
        ).toBeDefined();
        expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it("replaces direct cards without changing the new call identity", async () => {
      const first = await presentCard({
        replay: {
          ...REPLAY,
          authAttempt: {
            projectId: "p1",
            serverId: "orders",
            surface: "tools",
            callId: "first",
          },
        },
      });
      const second = await presentCard({
        replay: {
          ...REPLAY,
          authAttempt: {
            projectId: "p1",
            serverId: "orders",
            surface: "tools",
            callId: "second",
          },
        },
      });
      expect(Object.keys(useAuthChallengeCardStore.getState().cards)).toEqual([
        second.key,
      ]);
      clearAuthChallengeCards("orders", first.attempt);
      expect(
        useAuthChallengeCardStore.getState().cards[second.key],
      ).toBeDefined();
    });
    it("keeps a restoring comparison retryable without starting OAuth", async () => {
      const card = await presentCard();
      card.onConnect = () => ({ ok: false, reason: "loading" });
      expect(await connectAuthChallenge(card, server, { isTrusted: true })).toEqual({
        kind: "waiting", message: "Chats are still restoring. Please try Connect again in a moment.",
      });
      expect(initiateOAuthMock).not.toHaveBeenCalled();
      expect(useAuthChallengeCardStore.getState().cards[card.key]).toBeDefined();
    });
    it("keeps the card and never opens OAuth when its pending save fails", async () => {
      const card = await presentCard();
      card.onConnect = () => ({ ok: false, reason: "storage" });
      const result = await connectAuthChallenge(card, server, {
        isTrusted: true,
      });
      expect(result.kind).toBe("failed");
      expect(initiateOAuthMock).not.toHaveBeenCalled();
      expect(
        useAuthChallengeCardStore.getState().cards[card.key],
      ).toBeDefined();
    });
    it("refuses a click that is not a trusted user gesture", async () => {
      const card = await presentCard();
      const result = await connectAuthChallenge(card, server, {
        isTrusted: false,
      });
      expect(result).toEqual({ kind: "refused" });
      expect(initiateOAuthMock).not.toHaveBeenCalled();
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
    });

    it("saves a read-only call for replay, bound to a digest of the flow's state", async () => {
      const card = await presentCard();
      const result = await connectAuthChallenge(card, server, {
        isTrusted: true,
      });
      expect(result).toEqual({ kind: "started" });
      expect(peekPendingDirectScopeStepUpReplay()).toMatchObject({
        phase: "awaiting_oauth",
        reason: "authorization_required",
        flowDigest: await authorizationFlowDigest("flow-1"),
        descriptor: REPLAY,
      });
      expect(peekPendingDirectScopeStepUpReplay()).not.toHaveProperty(
        "requiresConfirmation",
      );
      // The state itself is never stored.
      expect(JSON.stringify({ ...sessionStorage })).not.toContain("flow-1");

      // Another flow's callback does not replay it.
      expect(
        await settleSignInCallback("orders", { state: "flow-other" }),
      ).toBe(SIGNED_IN_FOR_ANOTHER_REQUEST_MESSAGE);
      expect(peekPendingDirectScopeStepUpReplay()?.phase).toBe("awaiting_oauth");
    });

    it("explains a waiting call without replacing it or reporting failed storage", async () => {
      const first = await presentCard();
      await connectAuthChallenge(first, server, { isTrusted: true });
      const waiting = peekPendingDirectScopeStepUpReplay();
      const second = await presentCard({
        operation: { method: "tools/call", operation: "another_tool" },
        replay: { ...REPLAY, toolName: "another_tool" },
      });
      expect(await connectAuthChallenge(second, server, { isTrusted: true })).toEqual({
        kind: "failed",
        message: "Another call is waiting for sign-in. Finish that sign-in or wait for it to expire, then try again.",
      });
      expect(initiateOAuthMock).toHaveBeenCalledTimes(1);
      expect(peekPendingDirectScopeStepUpReplay()).toEqual(waiting);
      expect(sessionStorage.getItem("mcp-chat-auth-recovery-v1") ?? "").not.toContain("save_failed");
    });

    it("reports failed replay storage without rejecting a successful sign-in", async () => {
      const card = await presentCard();
      await connectAuthChallenge(card, server, { isTrusted: true });
      const original = Storage.prototype.setItem;
      const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === "mcp-scope-step-up-replay-v1") throw new Error("storage unavailable");
        return original.call(this, key, value);
      });
      try {
        await expect(settleSignInCallback("orders", { state: "flow-1" }))
          .resolves.toContain("MCPJam couldn’t continue this call");
        expect(peekPendingDirectScopeStepUpReplay()?.phase).toBe("awaiting_oauth");
      } finally { save.mockRestore(); }
    });

    it("replays after its own callback", async () => {
      const card = await presentCard();
      await connectAuthChallenge(card, server, { isTrusted: true });
      expect(
        await settleSignInCallback("orders", { state: "flow-1" }),
      ).toBeUndefined();
      expect(
        claimPendingDirectScopeStepUpReplay({
          serverName: "orders",
          surface: "tools",
        }),
      ).toMatchObject({ descriptor: REPLAY });
      expect(trackMock).toHaveBeenCalledWith(
        "auth_challenge_completed",
        expect.anything(),
      );
    });

    it("does not add a separate approval to a write replay", async () => {
      const card = await presentCard({ readOnly: false });
      await connectAuthChallenge(card, server, { isTrusted: true });
      expect(peekPendingDirectScopeStepUpReplay()).not.toHaveProperty(
        "requiresConfirmation",
      );
    });

    it("keeps the scopes of a hosted grant the browser cannot see", async () => {
      persistRequestedScopes("orders", "https://as.example", ["profile"]);
      const unregister = registerScopeStepUpHostBridge({
        hasExistingGrant: async () => true,
      });
      try {
        const card = await presentCard();
        await connectAuthChallenge(card, server, { isTrusted: true });
        expect(initiateOAuthMock).toHaveBeenCalledWith(
          expect.objectContaining({ scopes: ["profile", "orders:read"] }),
        );
      } finally {
        unregister();
      }
    });

    it("never replays onto a shared credential", async () => {
      const unregister = registerScopeStepUpHostBridge({
        resolveCredentialBinding: async () => ({
          kind: "shared",
          credentialId: "project-cred",
        }),
      });
      try {
        const card = await presentCard({ connectionId: "project-cred" });
        await connectAuthChallenge(card, server, { isTrusted: true });
        expect(
          await settleSignInCallback("orders", {
            state: "flow-1",
            credentialId: "personal-cred",
          }),
        ).toMatch(/own account/);
        expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
      } finally {
        unregister();
      }
    });

    it("drops the saved call when sign-in fails before redirecting", async () => {
      initiateOAuthMock.mockResolvedValueOnce({
        success: false,
        error: "metadata unreachable",
      });
      const card = await presentCard();
      const result = await connectAuthChallenge(card, server, {
        isTrusted: true,
      });
      expect(result).toEqual({
        kind: "failed",
        message: "metadata unreachable",
      });
      // No callback will come for it, so a later sign-in must not replay it.
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
    });

    it("drops the saved call when sign-in throws", async () => {
      initiateOAuthMock.mockRejectedValueOnce(new Error("boom"));
      const card = await presentCard();
      const result = await connectAuthChallenge(card, server, {
        isTrusted: true,
      });
      expect(result).toMatchObject({ kind: "failed" });
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
    });

    it("an expired card still signs in, without a replay", async () => {
      const card = await presentCard();
      const result = await connectAuthChallenge(
        { ...card, expiresAt: Date.now() - 1 },
        server,
        { isTrusted: true },
      );
      expect(result).toEqual({ kind: "expired" });
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
      expect(initiateOAuthMock).toHaveBeenCalled();
    });

    it("a notify card signs in without saving the call", async () => {
      unregisterProfile = registerAuthChallengeHostProfile(() => ({
        unauthorizedChallenge: "notify",
      }));
      const card = await presentCard();
      expect(card.action).toBe("notify");
      await connectAuthChallenge(card, server, { isTrusted: true });
      expect(peekPendingDirectScopeStepUpReplay()).toBeUndefined();
      expect(initiateOAuthMock).toHaveBeenCalled();
    });

    it("a repeat challenge after sign-in is permanent", async () => {
      const card = await presentCard();
      await connectAuthChallenge(card, server, { isTrusted: true });
      await settleSignInCallback("orders", { state: "flow-1" });
      const repeat = await presentAuthChallenge({
        server,
        signal: http401(),
        surface: "tools",
        operation: OPERATION,
        readOnly: true,
        replay: card.replay,
      });
      expect(repeat).toMatchObject({ kind: "notice", reason: "permanent" });
    });
  });

  describe("widgets", () => {
    it("shows the card under the widget's tool call, without a replay", async () => {
      presentWidgetAuthChallenge({
        server,
        signal: http401(),
        toolName: "list_orders",
        toolCallId: "call-widget",
      });
      await vi.waitFor(() =>
        expect(
          Object.values(useAuthChallengeCardStore.getState().cards),
        ).toEqual([
          expect.objectContaining({
            surface: "chat",
            toolCallId: "call-widget",
            action: "notify",
          }),
        ]),
      );
      const [card] = Object.values(useAuthChallengeCardStore.getState().cards);
      expect(card.replay).toBeUndefined();
      expect(initiateOAuthMock).not.toHaveBeenCalled();
    });

    it("records why a widget's challenge did not become a card", async () => {
      useAuthChallengeNoticeStore.setState({ notices: {} });
      presentWidgetAuthChallenge({
        server,
        signal: http401({ effectiveAuth: "bearer" }),
        toolName: "list_orders",
        toolCallId: "call-blocked",
      });
      await vi.waitFor(() =>
        expect(
          useAuthChallengeNoticeStore.getState().notices["call-blocked"],
        ).toMatchObject({ reason: "auth-method-blocked" }),
      );
      expect(
        useAuthChallengeNoticeStore.getState().notices["call-blocked"].action,
      ).not.toBe("passthrough");
    });

    it("does nothing without a tool call to render under", async () => {
      presentWidgetAuthChallenge({
        server,
        signal: http401(),
        toolName: "list_orders",
      });
      await Promise.resolve();
      expect(useAuthChallengeCardStore.getState().cards).toEqual({});
    });
  });
});
