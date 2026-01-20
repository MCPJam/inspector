/**
 * MCP OAuth Module Tests
 *
 * Tests for the OAuth fetch interceptor that proxies OAuth requests
 * through the backend to bypass CORS restrictions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the session-token module
vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

// Mock the helpers module
vi.mock("../state-machines/shared/helpers", () => ({
  generateRandomString: vi.fn(() => "mock-random-string"),
}));

describe("OAuth fetch interceptor", () => {
  let authFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    // Get the mocked authFetch
    const sessionToken = await import("@/lib/session-token");
    authFetch = sessionToken.authFetch as ReturnType<typeof vi.fn>;
    authFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("proxy endpoint auth failures", () => {
    it("returns 401 response directly when auth fails on proxy endpoint", async () => {
      // Simulate auth failure - middleware returns 401 with error body
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

      // Import the module fresh to get the interceptor
      const { initiateOAuth } = await import("../mcp-oauth");

      // Attempt OAuth flow - this will use the interceptor internally
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      // Should fail with an error, not succeed with masked 200
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("does not mask 401 as 200 with empty body", async () => {
      // This tests the specific bug where:
      // 1. authFetch returns 401 { error, message, hint }
      // 2. Code tried to access data.body, data.status (undefined)
      // 3. new Response(undefined, { status: undefined }) defaulted to 200

      const authErrorBody = {
        error: "Unauthorized",
        message: "Session token required.",
      };

      const authErrorResponse = new Response(JSON.stringify(authErrorBody), {
        status: 401,
        statusText: "Unauthorized",
      });

      authFetch.mockResolvedValue(authErrorResponse);

      // Dynamically import to get fresh module with mocked dependencies
      vi.resetModules();
      const mcpOauth = await import("../mcp-oauth");

      const result = await mcpOauth.initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      // The key assertion: auth failure should NOT result in success
      expect(result.success).toBe(false);
    });

    it("propagates successful proxy responses correctly", async () => {
      // First call: metadata fetch succeeds
      const metadataResponse = new Response(
        JSON.stringify({
          authorization_servers: ["https://auth.example.com"],
        }),
        { status: 200 },
      );

      authFetch.mockResolvedValue(metadataResponse);

      vi.resetModules();
      const mcpOauth = await import("../mcp-oauth");

      // This will fail later in the OAuth flow (no real auth server),
      // but the metadata fetch should succeed
      const result = await mcpOauth.initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      // Should have attempted to fetch metadata via authFetch
      expect(authFetch).toHaveBeenCalled();
    });
  });
});
