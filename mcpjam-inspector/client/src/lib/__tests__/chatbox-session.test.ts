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
      "abc 123",
    );
    expect(extractChatboxTokenFromPath("/chatbox/onlyone")).toBeNull();
    expect(extractChatboxTokenFromPath("/settings")).toBeNull();
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
      }),
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
      }),
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
      }),
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
      `${window.location.origin}/chatbox/demo-chatbox/token%20123`,
    );
  });

});
