import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSandboxLink,
  clearSandboxSession,
  clearSandboxSignInReturnPath,
  extractSandboxTokenFromPath,
  hasActiveSandboxSession,
  readSandboxSession,
  readSandboxSignInReturnPath,
  SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY,
  writeSandboxSession,
  writeSandboxSignInReturnPath,
} from "../sandbox-session";

describe("sandbox-session", () => {
  beforeEach(() => {
    clearSandboxSession();
    clearSandboxSignInReturnPath();
  });

  it("extracts token from /sandbox/<slug>/<token> paths", () => {
    expect(extractSandboxTokenFromPath("/sandbox/demo/abc123")).toBe("abc123");
    expect(extractSandboxTokenFromPath("/sandbox/demo/abc%20123")).toBe(
      "abc 123",
    );
    expect(extractSandboxTokenFromPath("/sandbox/onlyone")).toBeNull();
    expect(extractSandboxTokenFromPath("/settings")).toBeNull();
  });

  it("detects an active sandbox session", () => {
    expect(hasActiveSandboxSession()).toBe(false);

    writeSandboxSession({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Demo Sandbox",
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

    expect(hasActiveSandboxSession()).toBe(true);
  });

  it("round-trips sandbox session storage", () => {
    const payload = {
      workspaceId: "ws_1",
      sandboxId: "sbx_1",
      name: "Sandbox",
      description: "Hosted sandbox",
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

    writeSandboxSession({ token: "sandbox-token", payload });

    expect(readSandboxSession()).toEqual({
      token: "sandbox-token",
      payload,
    });
  });

  it("defaults missing hostStyle to claude for legacy sandbox sessions", () => {
    sessionStorage.setItem(
      "mcpjam_sandbox_session_v1",
      JSON.stringify({
        token: "sandbox-token",
        payload: {
          workspaceId: "ws_1",
          sandboxId: "sbx_1",
          name: "Legacy Sandbox",
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

    expect(readSandboxSession()).toEqual({
      token: "sandbox-token",
      payload: {
        workspaceId: "ws_1",
        sandboxId: "sbx_1",
        name: "Legacy Sandbox",
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
  });

  it("round-trips sandbox sign-in return path", () => {
    writeSandboxSignInReturnPath("/sandbox/demo/token-123");
    expect(readSandboxSignInReturnPath()).toBe("/sandbox/demo/token-123");

    clearSandboxSignInReturnPath();
    expect(readSandboxSignInReturnPath()).toBeNull();
  });

  it("ignores non-sandbox sign-in return paths", () => {
    writeSandboxSignInReturnPath("/servers");
    expect(readSandboxSignInReturnPath()).toBeNull();

    localStorage.setItem(SANDBOX_SIGN_IN_RETURN_PATH_STORAGE_KEY, "/servers");
    expect(readSandboxSignInReturnPath()).toBeNull();
  });

  it("builds sandbox links from the current browser origin", () => {
    expect(buildSandboxLink("token 123", "Demo Sandbox")).toBe(
      `${window.location.origin}/sandbox/demo-sandbox/token%20123`,
    );
  });
});
