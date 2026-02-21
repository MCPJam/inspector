import { describe, expect, it, beforeEach } from "vitest";
import {
  clearSharedSignInReturnPath,
  clearSharedServerSession,
  extractSharedTokenFromPath,
  hasActiveSharedSession,
  readSharedSignInReturnPath,
  readSharedServerSession,
  SHARED_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  slugify,
  writeSharedSignInReturnPath,
  writeSharedServerSession,
} from "../shared-server-session";

describe("shared-server-session", () => {
  beforeEach(() => {
    clearSharedServerSession();
    clearSharedSignInReturnPath();
  });

  it("extracts token from /shared/<slug>/<token> paths", () => {
    expect(extractSharedTokenFromPath("/shared/my-server/abc123")).toBe(
      "abc123",
    );
    expect(extractSharedTokenFromPath("/shared/my%20server/abc%20123")).toBe(
      "abc 123",
    );
    expect(extractSharedTokenFromPath("/shared/onlyone")).toBeNull();
    expect(extractSharedTokenFromPath("/settings")).toBeNull();
  });

  it("slugifies server names", () => {
    expect(slugify("My Cool Server")).toBe("my-cool-server");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
    expect(slugify("special!@#chars")).toBe("specialchars");
    expect(slugify("under_scores")).toBe("under-scores");
    expect(slugify("---dashes---")).toBe("dashes");
  });

  it("detects active shared session", () => {
    expect(hasActiveSharedSession()).toBe(false);

    writeSharedServerSession({
      token: "t",
      payload: {
        workspaceId: "ws_1",
        serverId: "srv_1",
        serverName: "S",
        mode: "invited_only",
        viewerIsWorkspaceMember: false,
        useOAuth: false,
        serverUrl: null,
        clientId: null,
        oauthScopes: null,
      },
    });

    expect(hasActiveSharedSession()).toBe(true);
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
    writeSharedSignInReturnPath("/shared/server-one/token-123");
    expect(readSharedSignInReturnPath()).toBe("/shared/server-one/token-123");

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
