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
});
