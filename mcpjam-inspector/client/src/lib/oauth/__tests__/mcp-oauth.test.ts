/**
 * MCP OAuth Module Tests
 *
 * Tests for the OAuth fetch interceptor and persisted discovery state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSdkAuth } = vi.hoisted(() => ({
  mockSdkAuth: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mockSdkAuth,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("../state-machines/shared/helpers", () => ({
  generateRandomString: vi.fn(() => "mock-random-string"),
}));

function createDiscoveryState(): any {
  return {
    authorizationServerUrl: "https://auth.example.com",
    resourceMetadataUrl:
      "https://example.com/.well-known/oauth-protected-resource",
    resourceMetadata: {
      resource: "https://example.com",
      authorization_servers: ["https://auth.example.com"],
    },
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    },
  };
}

describe("mcp-oauth", () => {
  let authFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    mockSdkAuth.mockReset();
    window.isElectron = false;
    delete window.electronAPI;

    const sessionToken = await import("@/lib/session-token");
    authFetch = sessionToken.authFetch as ReturnType<typeof vi.fn>;
    authFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.isElectron = false;
    delete window.electronAPI;
  });

  describe("proxy endpoint auth failures", () => {
    it("returns 401 response directly when auth fails on proxy endpoint", async () => {
      const authErrorResponse = new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "Session token required.",
          hint: "Include X-MCP-Session-Auth: Bearer <token> header",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      );
      authFetch.mockResolvedValue(authErrorResponse);
      mockSdkAuth.mockImplementation(async () => {
        const response = await window.fetch(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return "AUTHORIZED";
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("does not mask 401 as 200 with empty body", async () => {
      const authErrorResponse = new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "Session token required.",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
        },
      );
      authFetch.mockResolvedValue(authErrorResponse);
      mockSdkAuth.mockImplementation(async () => {
        const response = await window.fetch(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return "AUTHORIZED";
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(false);
    });

    it("propagates successful proxy responses correctly", async () => {
      const metadataResponse = new Response(
        JSON.stringify({
          authorization_servers: ["https://auth.example.com"],
        }),
        { status: 200 },
      );
      authFetch.mockResolvedValue(metadataResponse);
      mockSdkAuth.mockImplementation(async () => {
        const response = await window.fetch(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        expect(response.ok).toBe(true);
        return "REDIRECT";
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(true);
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/api\/mcp\/oauth\/metadata\?url=.*oauth-protected-resource/,
        ),
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("persisted discovery state", () => {
    it("tags Electron-started OAuth state for desktop callback recovery", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );

      window.isElectron = true;

      expect(provider.state()).toMatch(/^electron_mcp:mock-random-string$/);
    });

    it("keeps browser OAuth state untagged", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );

      window.isElectron = false;

      expect(provider.state()).toBe("mock-random-string");
    });

    it("falls back to in-app navigation when Electron browser open fails", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      const navigateSpy = vi
        .spyOn(provider, "navigateToUrl")
        .mockImplementation(() => {});
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const openExternal = vi
        .fn()
        .mockRejectedValue(new Error("system browser unavailable"));

      window.isElectron = true;
      window.electronAPI = {
        app: {
          openExternal,
        },
      } as any;

      await provider.redirectToAuthorization(
        new URL("https://auth.example.com/authorize"),
      );

      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.example.com/authorize",
      );
      expect(navigateSpy).toHaveBeenCalledWith(
        "https://auth.example.com/authorize",
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("round-trips discovery state for the matching server URL", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const discoveryState = createDiscoveryState();
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );

      await provider.saveDiscoveryState(discoveryState);

      expect(provider.discoveryState()).toEqual(discoveryState);
    });

    it("ignores stale discovery state when the server URL changes", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const discoveryState = createDiscoveryState();
      const originalProvider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await originalProvider.saveDiscoveryState(discoveryState);

      const nextProvider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/alt-sse",
      );

      expect(nextProvider.discoveryState()).toBeUndefined();
    });

    it('clears discovery state on invalidateCredentials("all")', async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await provider.saveDiscoveryState(createDiscoveryState());

      await provider.invalidateCredentials("all");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it('clears discovery state on invalidateCredentials("discovery")', async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await provider.saveDiscoveryState(createDiscoveryState());

      await provider.invalidateCredentials("discovery");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it("clears discovery state in clearOAuthData", async () => {
      const { MCPOAuthProvider, clearOAuthData } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await provider.saveDiscoveryState(createDiscoveryState());

      clearOAuthData("asana");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it("reuses cached discovery state after the callback reload", async () => {
      const discoveryState = createDiscoveryState();
      mockSdkAuth
        .mockImplementationOnce(async (provider) => {
          await provider.saveDiscoveryState?.(discoveryState);
          return "REDIRECT";
        })
        .mockImplementationOnce(async (provider, options) => {
          expect(options.authorizationCode).toBe("oauth-code");
          expect(provider.discoveryState?.()).toEqual(discoveryState);
          await provider.saveTokens({
            access_token: "access-token",
            refresh_token: "refresh-token",
          });
          return "AUTHORIZED";
        });

      const { getStoredTokens, handleOAuthCallback, initiateOAuth } =
        await import("../mcp-oauth");

      const initiateResult = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      });
      expect(initiateResult).toEqual({ success: true });

      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.serverName).toBe("asana");
      expect(callbackResult.serverConfig?.requestInit?.headers).toEqual({
        Authorization: "Bearer access-token",
      });
      expect(getStoredTokens("asana")?.access_token).toBe("access-token");
      expect(localStorage.getItem("mcp-discovery-asana")).not.toBeNull();
      expect(mockSdkAuth).toHaveBeenCalledTimes(2);
    });

    it("treats malformed stored token data as invalid instead of throwing", async () => {
      const { getStoredTokens, getStoredTokensState } =
        await import("../mcp-oauth");

      localStorage.setItem("mcp-tokens-asana", '{"access_token":"broken"');
      localStorage.setItem("mcp-client-asana", '{"client_id":"broken"');

      expect(getStoredTokens("asana")).toBeUndefined();
      expect(getStoredTokensState("asana")).toEqual({
        tokens: undefined,
        isInvalid: true,
      });
    });
  });
});
