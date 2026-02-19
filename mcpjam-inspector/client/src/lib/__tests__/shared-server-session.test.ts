import { describe, expect, it, beforeEach } from "vitest";
import {
  clearSharedSignInReturnPath,
  clearSharedServerSession,
  extractSharedTokenFromPath,
  isSharedChatHash,
  readSharedSignInReturnPath,
  readSharedServerSession,
  SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  writeSharedSignInReturnPath,
  writeSharedServerSession,
} from "../shared-server-session";

describe("shared-server-session", () => {
  beforeEach(() => {
    clearSharedServerSession();
    clearSharedSignInReturnPath();
  });

  it("extracts token from /shared/<token> paths", () => {
    expect(extractSharedTokenFromPath("/shared/abc123")).toBe("abc123");
    expect(extractSharedTokenFromPath("/shared/abc%20123")).toBe("abc 123");
    expect(extractSharedTokenFromPath("/settings")).toBeNull();
  });

  it("detects canonical shared chat hash", () => {
    expect(isSharedChatHash("#shared-chat")).toBe(true);
    expect(isSharedChatHash("#/shared-chat")).toBe(true);
    expect(isSharedChatHash("#chat-v2")).toBe(false);
  });

  it("round-trips session storage", () => {
    const payload = {
      workspaceId: "ws_1",
      serverId: "srv_1",
      serverName: "Server",
      mode: "invited_only" as const,
      viewerIsWorkspaceMember: false,
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
    };

    writeSharedServerSession({ token: "token-123", payload });

    expect(readSharedServerSession()).toEqual({
      token: "token-123",
      payload,
    });

    clearSharedServerSession();
    expect(readSharedServerSession()).toBeNull();
  });

  it("round-trips session with OAuth fields", () => {
    const payload = {
      workspaceId: "ws_2",
      serverId: "srv_2",
      serverName: "OAuth Server",
      mode: "any_signed_in_with_link" as const,
      viewerIsWorkspaceMember: true,
      useOAuth: true,
      serverUrl: "https://mcp.example.com",
      clientId: "client-123",
      oauthScopes: ["read", "write"],
    };

    writeSharedServerSession({ token: "token-456", payload });

    expect(readSharedServerSession()).toEqual({
      token: "token-456",
      payload,
    });
  });

  it("defaults OAuth fields for legacy sessions without them", () => {
    // Simulate a session stored before OAuth fields were added
    const legacySession = {
      token: "legacy-token",
      payload: {
        workspaceId: "ws_1",
        serverId: "srv_1",
        serverName: "Server",
        mode: "invited_only",
        viewerIsWorkspaceMember: false,
      },
    };

    sessionStorage.setItem(
      "mcpjam_shared_server_session_v1",
      JSON.stringify(legacySession),
    );

    const result = readSharedServerSession();
    expect(result).not.toBeNull();
    expect(result!.payload.useOAuth).toBe(false);
    expect(result!.payload.serverUrl).toBeNull();
    expect(result!.payload.clientId).toBeNull();
    expect(result!.payload.oauthScopes).toBeNull();
  });

  it("round-trips shared sign-in return path", () => {
    writeSharedSignInReturnPath("/shared/token-123");
    expect(readSharedSignInReturnPath()).toBe("/shared/token-123");

    clearSharedSignInReturnPath();
    expect(readSharedSignInReturnPath()).toBeNull();
  });

  it("ignores non-shared sign-in return paths", () => {
    writeSharedSignInReturnPath("/servers");
    expect(readSharedSignInReturnPath()).toBeNull();

    localStorage.setItem(SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY, "/servers");
    expect(readSharedSignInReturnPath()).toBeNull();
  });
});
