import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "../app-types";

const {
  clearOAuthDataMock,
  getStoredTokensMock,
  initiateOAuthMock,
  readStoredOAuthConfigMock,
  refreshOAuthTokensMock,
} = vi.hoisted(() => ({
  clearOAuthDataMock: vi.fn(),
  getStoredTokensMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  refreshOAuthTokensMock: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  clearOAuthData: clearOAuthDataMock,
  getStoredTokens: getStoredTokensMock,
  hasOAuthConfig: vi.fn(),
  initiateOAuth: initiateOAuthMock,
  readStoredOAuthConfig: readStoredOAuthConfigMock,
  refreshOAuthTokens: refreshOAuthTokensMock,
}));

import { ensureAuthorizedForReconnect } from "../oauth-orchestrator";

describe("ensureAuthorizedForReconnect", () => {
  const createServer = (
    overrides: Partial<ServerWithName> = {},
  ): ServerWithName =>
    ({
      name: "asana",
      config: {
        type: "http",
        url: "https://mcp.asana.com/sse",
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
      useOAuth: true,
      oauthTokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
      },
      ...overrides,
    }) as ServerWithName;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getStoredTokensMock.mockReturnValue(undefined);
    readStoredOAuthConfigMock.mockReturnValue({});
  });

  it("returns reauth_required instead of starting a fresh OAuth flow when interactive OAuth is disabled", async () => {
    refreshOAuthTokensMock.mockResolvedValue({
      success: false,
      error: "invalid_grant",
      oauthTrace: { steps: [] },
    });

    const result = await ensureAuthorizedForReconnect(createServer(), {
      allowInteractiveOAuthFlow: false,
    });

    expect(refreshOAuthTokensMock).toHaveBeenCalledWith(
      "asana",
      expect.objectContaining({
        onTraceUpdate: undefined,
      }),
    );
    expect(readStoredOAuthConfigMock).not.toHaveBeenCalled();
    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        kind: "reauth_required",
        error: expect.stringContaining("Click Reconnect"),
      }),
    );
  });

  it("still starts the browser flow when interactive OAuth is allowed", async () => {
    refreshOAuthTokensMock.mockResolvedValue({
      success: false,
      error: "invalid_grant",
    });
    initiateOAuthMock.mockResolvedValue({ success: true });
    const beforeRedirect = vi.fn();

    const result = await ensureAuthorizedForReconnect(createServer(), {
      allowInteractiveOAuthFlow: true,
      beforeRedirect,
    });

    expect(beforeRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      }),
    );
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      }),
    );
    expect(result).toEqual({ kind: "redirect" });
  });

  it("starts a fresh OAuth flow for a URL-only OAuth server without stored tokens", async () => {
    initiateOAuthMock.mockResolvedValue({ success: true });

    const result = await ensureAuthorizedForReconnect(
      createServer({ oauthTokens: undefined }),
      {
        allowInteractiveOAuthFlow: true,
      },
    );

    expect(clearOAuthDataMock).toHaveBeenCalledWith("asana");
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      }),
    );
    expect(result).toEqual({ kind: "redirect" });
  });

  it("preserves advanced OAuth setup before clearing stale reconnect data", async () => {
    readStoredOAuthConfigMock.mockReturnValue({
      scopes: ["stale-scope"],
      customHeaders: {
        Authorization: "Bearer stale-token",
        "X-Stale": "browser",
      },
      registryServerId: "registry-asana",
      useRegistryOAuthProxy: true,
      protocolMode: "2025-03-26",
      protocolVersion: "2025-03-26",
      registrationMode: "dcr",
      registrationStrategy: "dcr",
    });
    localStorage.setItem(
      "mcp-client-asana",
      JSON.stringify({
        client_id: "stored-client-id",
        client_secret: "stored-client-secret",
      }),
    );
    clearOAuthDataMock.mockImplementationOnce((serverName: string) => {
      localStorage.removeItem(`mcp-client-${serverName}`);
    });
    initiateOAuthMock.mockResolvedValue({ success: true });

    const server = createServer({
      oauthTokens: undefined,
      oauthFlowProfile: {
        serverUrl: "https://mcp.asana.com/sse",
        resourceUrl: "https://mcp.asana.com",
        clientId: "",
        clientSecret: "",
        scopes: "default profile",
        customHeaders: [{ key: "X-MCPJam", value: "yes" }],
        protocolVersion: "2025-11-25",
        registrationStrategy: "preregistered",
      },
    });

    await ensureAuthorizedForReconnect(server, {
      allowInteractiveOAuthFlow: true,
    });

    expect(clearOAuthDataMock).toHaveBeenCalledWith("asana");
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
        scopes: ["default", "profile"],
        resourceUrl: "https://mcp.asana.com",
        customHeaders: { "X-MCPJam": "yes" },
        registryServerId: "registry-asana",
        useRegistryOAuthProxy: true,
        clientId: "stored-client-id",
        clientSecret: "stored-client-secret",
        protocolMode: "2025-11-25",
        protocolVersion: "2025-11-25",
        registrationMode: "preregistered",
        registrationStrategy: "preregistered",
      }),
    );
    expect(clearOAuthDataMock.mock.invocationCallOrder[0]).toBeLessThan(
      initiateOAuthMock.mock.invocationCallOrder[0],
    );
  });

  it("strips authorization when falling back to server headers for OAuth retry", async () => {
    initiateOAuthMock.mockResolvedValue({ success: true });

    await ensureAuthorizedForReconnect(
      createServer({
        oauthTokens: undefined,
        config: {
          type: "http",
          url: "https://mcp.asana.com/sse",
          requestInit: {
            headers: {
              Authorization: "Bearer old-token",
              "X-MCPJam": "yes",
            },
          },
        } as any,
      }),
      {
        allowInteractiveOAuthFlow: true,
      },
    );

    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customHeaders: { "X-MCPJam": "yes" },
      }),
    );
  });

  it("uses stored localStorage tokens to refresh silently when server.oauthTokens is undefined (post-reload local mode)", async () => {
    // After a page reload in local (non-hosted) mode, `server.oauthTokens`
    // is undefined because nothing hydrates the reducer state from
    // localStorage at startup. The auto-reconnect path must still find the
    // persisted refresh token via `getStoredTokens` and run a silent
    // refresh — otherwise OAuth servers land in `reauth_required` even
    // though valid tokens sit on disk.
    getStoredTokensMock.mockReturnValue({
      access_token: "stored-access",
      refresh_token: "stored-refresh",
    });
    refreshOAuthTokensMock.mockResolvedValue({
      success: true,
      serverConfig: {
        type: "http",
        url: "https://mcp.asana.com/sse",
      },
      oauthTrace: { steps: [] },
    });

    const result = await ensureAuthorizedForReconnect(
      createServer({ oauthTokens: undefined }),
      { allowInteractiveOAuthFlow: false },
    );

    expect(refreshOAuthTokensMock).toHaveBeenCalledWith(
      "asana",
      expect.any(Object),
    );
    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        kind: "ready",
        serverConfig: expect.objectContaining({
          url: "https://mcp.asana.com/sse",
        }),
        tokens: expect.objectContaining({
          access_token: "stored-access",
        }),
      }),
    );
  });

  it("skips refresh and returns reauth_required when no in-memory or stored tokens exist", async () => {
    // Mirror of the case above: OAuth-enabled server with neither
    // reducer-state tokens nor localStorage-persisted tokens. The new
    // `hasRefreshCandidate` gate must not fire a refresh (no token to
    // refresh against) — and with interactive OAuth disabled, the result
    // is reauth_required.
    getStoredTokensMock.mockReturnValue(undefined);

    const result = await ensureAuthorizedForReconnect(
      createServer({ oauthTokens: undefined }),
      { allowInteractiveOAuthFlow: false },
    );

    expect(refreshOAuthTokensMock).not.toHaveBeenCalled();
    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ kind: "reauth_required" }),
    );
  });

  it("does not launch OAuth for a server explicitly saved without OAuth", async () => {
    const server = createServer({
      useOAuth: false,
      oauthTokens: undefined,
    });

    const result = await ensureAuthorizedForReconnect(server, {
      allowInteractiveOAuthFlow: true,
    });

    expect(clearOAuthDataMock).toHaveBeenCalledWith("asana");
    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "ready",
      serverConfig: server.config,
      tokens: undefined,
    });
  });
});
