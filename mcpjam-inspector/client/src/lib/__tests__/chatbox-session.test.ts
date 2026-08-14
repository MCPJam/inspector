import { beforeEach, describe, expect, it } from "vitest";
import {
  buildChatboxLink,
  clearChatboxSession,
  clearChatboxSignInReturnPath,
  extractChatboxTokenFromPath,
  hasActiveChatboxSession,
  readChatboxSurfaceFromUrl,
  readChatboxSession,
  readChatboxSignInReturnPath,
  CHATBOX_SESSION_STORAGE_KEY,
  CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  normalizeChatboxSession,
  writeChatboxSession,
  writeChatboxSignInReturnPath,
} from "../chatbox-session";

describe("chatbox-session", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearChatboxSession();
    clearChatboxSignInReturnPath();
  });

  it("extracts token from /chatbox/<slug>/<token> paths", () => {
    expect(extractChatboxTokenFromPath("/chatbox/demo/abc123")).toBe("abc123");
    expect(extractChatboxTokenFromPath("/chatbox/demo/abc%20123")).toBe(
      "abc 123"
    );
    expect(extractChatboxTokenFromPath("/chatbox/onlyone")).toBeNull();
    expect(extractChatboxTokenFromPath("/settings")).toBeNull();
  });

  it("extracts token from /user-testing/<slug>/<token> paths", () => {
    expect(extractChatboxTokenFromPath("/user-testing/demo/abc123")).toBe(
      "abc123"
    );
    // The scenario screen lives one segment shorter, and must NOT be read as a
    // tester link — doing so renders the public runtime over the app screen.
    expect(extractChatboxTokenFromPath("/user-testing/host_123")).toBeNull();
    expect(extractChatboxTokenFromPath("/user-testing/new")).toBeNull();
  });

  it("detects an active chatbox session", () => {
    expect(hasActiveChatboxSession()).toBe(false);

    writeChatboxSession({
      chatboxId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        chatboxId: "sbx_1",
        name: "Demo Chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    expect(hasActiveChatboxSession()).toBe(true);
  });

  it("round-trips chatbox session storage", () => {
    const payload = {
      projectId: "ws_1",
      chatboxId: "sbx_1",
      name: "Chatbox",
      description: "Hosted chatbox",
      hostStyle: "chatgpt" as const,
      mode: "anyone_with_link" as const,
      allowGuestAccess: true,
      viewerIsProjectMember: false,
      systemPrompt: "System prompt",
      modelId: "openai/gpt-5-mini",
      temperature: 0.7,
      requireToolApproval: false,
      servers: [
        {
          serverId: "srv_1",
          serverName: "Bench",
          useOAuth: true,
          serverUrl: "https://example.com/mcp",
          clientId: "client_1",
          oauthScopes: ["read"],
          oauthProtocolMode: "auto",
          oauthProtocolVersion: "2026-07-28",
          wireProtocolVersion: "2026-07-28",
        },
      ],
    };

    writeChatboxSession({ chatboxId: "sbx_1", accessVersion: 4, payload });

    expect(readChatboxSession()).toEqual({
      chatboxId: "sbx_1",
      accessVersion: 4,
      payload: {
        ...payload,
        servers: [
          {
            serverId: "srv_1",
            serverName: "Bench",
            useOAuth: true,
            serverUrl: "https://example.com/mcp",
            clientId: "client_1",
            oauthScopes: ["read"],
            oauthProtocolMode: "auto",
            oauthProtocolVersion: "2026-07-28",
            wireProtocolVersion: "2026-07-28",
            optional: false,
          },
        ],
        chatUi: undefined,
      },
      surface: "share_link",
    });
  });

  it("round-trips the share token — recovery's only way back to a grant", () => {
    // The post-redeem URL strip removes the token from the address bar, so
    // the persisted copy is what re-redeem reads. A session that dropped it
    // could never recover from a rebind or a rotated guest identity.
    const payload = {
      projectId: "ws_1",
      chatboxId: "sbx_1",
      name: "Demo Chatbox",
      hostStyle: "claude" as const,
      mode: "anyone_with_link" as const,
      allowGuestAccess: true,
      viewerIsProjectMember: false,
      systemPrompt: "You are helpful.",
      modelId: "openai/gpt-5-mini",
      temperature: 0.4,
      requireToolApproval: false,
      servers: [],
    };

    writeChatboxSession({
      chatboxId: "sbx_1",
      accessVersion: 2,
      payload,
      shareToken: "tok_share",
    });

    expect(readChatboxSession()?.shareToken).toBe("tok_share");
  });

  it("rejects stored sessions that lack a top-level chatboxId or accessVersion", () => {
    sessionStorage.setItem(
      CHATBOX_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: "chatbox-token",
        payload: {
          projectId: "ws_1",
          chatboxId: "sbx_1",
          name: "Old Chatbox",
          hostStyle: "claude",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );

    // Stored row predates the post-refactor session shape; reading it must
    // produce null so the landing page falls through to re-redeem rather than
    // silently driving the read path without a chatboxId/accessVersion.
    expect(readChatboxSession()).toBeNull();
  });

  it("defaults missing hostStyle to mcpjam for legacy chatbox sessions", () => {
    sessionStorage.setItem(
      CHATBOX_SESSION_STORAGE_KEY,
      JSON.stringify({
        chatboxId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          chatboxId: "sbx_1",
          name: "Legacy Chatbox",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );

    expect(readChatboxSession()).toEqual({
      chatboxId: "sbx_1",
      accessVersion: 1,
      payload: {
        projectId: "ws_1",
        chatboxId: "sbx_1",
        name: "Legacy Chatbox",
        description: undefined,
        hostStyle: "mcpjam",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
        chatUi: undefined,
      },
      surface: "share_link",
    });
  });

  it("preserves extensible hostStyle ids before a host definition is registered", () => {
    sessionStorage.setItem(
      CHATBOX_SESSION_STORAGE_KEY,
      JSON.stringify({
        chatboxId: "sbx_1",
        accessVersion: 1,
        payload: {
          projectId: "ws_1",
          chatboxId: "sbx_1",
          name: "Codex Chatbox",
          hostStyle: "codex",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsProjectMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      })
    );

    expect(readChatboxSession()?.payload.hostStyle).toBe("codex");
  });

  it("preserves preview surface when explicitly stored", () => {
    writeChatboxSession({
      chatboxId: "sbx_1",
      accessVersion: 1,
      surface: "preview",
      payload: {
        projectId: "ws_1",
        chatboxId: "sbx_1",
        name: "Playground Chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsProjectMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    expect(readChatboxSession()?.surface).toBe("preview");
  });

  it("reads chatbox surface from the url query", () => {
    expect(readChatboxSurfaceFromUrl("?surface=preview")).toBe("preview");
    expect(readChatboxSurfaceFromUrl("?surface=share_link")).toBe("share_link");
    expect(readChatboxSurfaceFromUrl("?surface=other")).toBe("share_link");
    expect(readChatboxSurfaceFromUrl("")).toBe("share_link");
  });

  it("round-trips chatbox sign-in return path", () => {
    writeChatboxSignInReturnPath("/user-testing/demo/token-123");
    expect(readChatboxSignInReturnPath()).toBe("/user-testing/demo/token-123");

    clearChatboxSignInReturnPath();
    writeChatboxSignInReturnPath("/chatbox/demo/token-123");
    expect(readChatboxSignInReturnPath()).toBe("/chatbox/demo/token-123");

    clearChatboxSignInReturnPath();
    expect(readChatboxSignInReturnPath()).toBeNull();
  });

  it("ignores non-chatbox sign-in return paths", () => {
    writeChatboxSignInReturnPath("/servers");
    expect(readChatboxSignInReturnPath()).toBeNull();

    localStorage.setItem(CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY, "/servers");
    expect(readChatboxSignInReturnPath()).toBeNull();
  });

  it("builds chatbox links from the current browser origin", () => {
    expect(buildChatboxLink("token 123", "Demo Chatbox")).toBe(
      `${window.location.origin}/user-testing/demo-chatbox/token%20123`
    );
  });
});

/**
 * The chatUi envelope carries what the hosted runtime is allowed to render.
 * Its normalizer is an ALLOWLIST — a surface it does not recognize is dropped
 * silently, which is exactly how a config can ship and appear to do nothing.
 */
describe("chatUi surface normalization", () => {
  function session(chatUi: unknown) {
    return {
      chatboxId: "cbx_1",
      accessVersion: 1,
      payload: {
        projectId: "proj_1",
        chatboxId: "cbx_1",
        name: "Scenario",
        hostStyle: "claude",
        mode: "anyone_with_link",
        allowGuestAccess: true,
        viewerIsProjectMember: false,
        systemPrompt: "",
        modelId: "gpt-4o-mini",
        temperature: 0.5,
        requireToolApproval: false,
        servers: [],
        chatUi,
      },
    } as never;
  }

  it("keeps per-turn feedback config on a scenario with no welcome dialog", () => {
    // The normalizer used to return undefined unless `welcome` parsed, which
    // would have dropped the ratings config on most scenarios — they have no
    // welcome dialog.
    const normalized = normalizeChatboxSession(
      session({
        surfaces: {
          perTurnFeedback: { enabled: true, prompt: "How was that?" },
        },
      })
    );
    expect(normalized?.payload.chatUi?.surfaces?.perTurnFeedback).toEqual({
      enabled: true,
      prompt: "How was that?",
    });
  });

  it("keeps both surfaces when both are present", () => {
    const normalized = normalizeChatboxSession(
      session({
        surfaces: {
          welcome: { enabled: true, body: "hello" },
          perTurnFeedback: { enabled: false },
        },
      })
    );
    expect(normalized?.payload.chatUi?.surfaces?.welcome).toEqual({
      enabled: true,
      body: "hello",
    });
    expect(normalized?.payload.chatUi?.surfaces?.perTurnFeedback).toEqual({
      enabled: false,
    });
  });

  it("drops the deprecated session-level feedback dialog", () => {
    // Its write path and storage table are gone; carrying it into the runtime
    // would offer a dialog that saves nowhere.
    const normalized = normalizeChatboxSession(
      session({ surfaces: { feedback: { enabled: true } } })
    );
    expect(normalized?.payload.chatUi).toBeUndefined();
  });

  it("never null-punches an omitted optional string", () => {
    const normalized = normalizeChatboxSession(
      session({ surfaces: { perTurnFeedback: { enabled: true } } })
    );
    expect(
      normalized?.payload.chatUi?.surfaces?.perTurnFeedback
    ).not.toHaveProperty("prompt");
  });
});
