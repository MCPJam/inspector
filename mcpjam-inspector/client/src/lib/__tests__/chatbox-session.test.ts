import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPlaygroundChatboxLink,
  buildChatboxLink,
  clearBuilderSession,
  clearPlaygroundSession,
  clearChatboxSession,
  clearChatboxSignInReturnPath,
  extractChatboxTokenFromPath,
  hasActiveChatboxSession,
  readBuilderSession,
  readPlaygroundSession,
  readChatboxSurfaceFromUrl,
  readChatboxSession,
  readChatboxSignInReturnPath,
  CHATBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  writeBuilderSession,
  writePlaygroundSession,
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
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Demo Chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
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
      workspaceId: "ws_1",
      chatboxId: "sbx_1",
      name: "Chatbox",
      description: "Hosted chatbox",
      hostStyle: "chatgpt" as const,
      mode: "any_signed_in_with_link" as const,
      allowGuestAccess: true,
      viewerIsWorkspaceMember: false,
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
        },
      ],
    };

    writeChatboxSession({ token: "chatbox-token", payload });

    expect(readChatboxSession()).toEqual({
      token: "chatbox-token",
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
            optional: false,
          },
        ],
        welcomeDialog: undefined,
      },
      surface: "share_link",
    });
  });

  it("defaults missing hostStyle to claude for legacy chatbox sessions", () => {
    sessionStorage.setItem(
      "mcpjam_chatbox_session_v1",
      JSON.stringify({
        token: "chatbox-token",
        payload: {
          workspaceId: "ws_1",
          chatboxId: "sbx_1",
          name: "Legacy Chatbox",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsWorkspaceMember: true,
          systemPrompt: "You are helpful.",
          modelId: "openai/gpt-5-mini",
          temperature: 0.4,
          requireToolApproval: true,
          servers: [],
        },
      }),
    );

    expect(readChatboxSession()).toEqual({
      token: "chatbox-token",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Legacy Chatbox",
        description: undefined,
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
      surface: "share_link",
    });
  });

  it("preserves extensible hostStyle ids before a host definition is registered", () => {
    sessionStorage.setItem(
      "mcpjam_chatbox_session_v1",
      JSON.stringify({
        token: "chatbox-token",
        payload: {
          workspaceId: "ws_1",
          chatboxId: "sbx_1",
          name: "Codex Chatbox",
          hostStyle: "codex",
          mode: "invited_only",
          allowGuestAccess: false,
          viewerIsWorkspaceMember: true,
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
      token: "chatbox-token",
      surface: "preview",
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Playground Chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    expect(readChatboxSession()?.surface).toBe("preview");
  });

  it("round-trips playground sessions until their ttl expires", () => {
    writePlaygroundSession({
      playgroundId: "pg_123",
      token: "chatbox-token",
      surface: "preview",
      updatedAt: Date.now(),
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Playground Chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    const stored = readPlaygroundSession("pg_123");
    expect(stored).toEqual(
      expect.objectContaining({
        playgroundId: "pg_123",
        token: "chatbox-token",
        surface: "preview",
      }),
    );
    expect(typeof stored?.updatedAt).toBe("number");

    if (!stored) {
      throw new Error("expected stored playground session");
    }

    localStorage.setItem(
      "mcpjam_chatbox_playground_session_v1:pg_123",
      JSON.stringify({
        ...stored,
        updatedAt: Date.now() - 24 * 60 * 60 * 1000 - 1,
      }),
    );

    expect(readPlaygroundSession("pg_123")).toBeNull();
  });

  it("reads chatbox surface from the url query", () => {
    expect(readChatboxSurfaceFromUrl("?surface=preview")).toBe("preview");
    expect(readChatboxSurfaceFromUrl("?surface=share_link")).toBe("share_link");
    expect(readChatboxSurfaceFromUrl("?surface=other")).toBe("share_link");
    expect(readChatboxSurfaceFromUrl("")).toBe("share_link");
  });

  it("builds chatbox playground links with preview surface params", () => {
    expect(
      buildPlaygroundChatboxLink("token 123", "Demo Chatbox", "pg_123"),
    ).toBe(
      `${window.location.origin}/chatbox/demo-chatbox/token%20123?playground=1&surface=preview&playgroundId=pg_123`,
    );
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

  it("clears stored playground sessions", () => {
    writePlaygroundSession({
      playgroundId: "pg_123",
      token: "chatbox-token",
      surface: "preview",
      updatedAt: Date.now(),
      payload: {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        name: "Chatbox",
        hostStyle: "claude",
        mode: "invited_only",
        allowGuestAccess: false,
        viewerIsWorkspaceMember: true,
        systemPrompt: "You are helpful.",
        modelId: "openai/gpt-5-mini",
        temperature: 0.4,
        requireToolApproval: true,
        servers: [],
      },
    });

    clearPlaygroundSession("pg_123");
    expect(readPlaygroundSession("pg_123")).toBeNull();
  });

  describe("builder session", () => {
    it("returns null when no session exists", () => {
      expect(readBuilderSession("ws_1")).toBeNull();
    });

    it("round-trips a builder session", () => {
      const session = {
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        draft: { name: "Test", hostStyle: "claude" },
        viewMode: "preview",
      };

      writeBuilderSession(session);
      expect(readBuilderSession("ws_1")).toEqual(session);
    });

    it("returns null when workspaceId does not match", () => {
      writeBuilderSession({
        workspaceId: "ws_1",
        chatboxId: null,
        draft: null,
        viewMode: "builder",
      });

      expect(readBuilderSession("ws_other")).toBeNull();
    });

    it("clears the builder session", () => {
      writeBuilderSession({
        workspaceId: "ws_1",
        chatboxId: "sbx_1",
        draft: null,
        viewMode: "builder",
      });

      clearBuilderSession();
      expect(readBuilderSession("ws_1")).toBeNull();
    });

    it("returns null for corrupted JSON", () => {
      sessionStorage.setItem(
        "mcpjam_chatbox_builder_session_v1",
        "not-valid-json",
      );
      expect(readBuilderSession("ws_1")).toBeNull();
    });
  });
});
