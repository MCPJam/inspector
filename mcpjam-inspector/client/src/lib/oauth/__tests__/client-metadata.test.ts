/**
 * Tests that OAuth client metadata includes logo_uri for branding
 * during OAuth consent flows (issue #1552).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock browser dependencies used by the providers
vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("../state-machines/shared/helpers", () => ({
  generateRandomString: vi.fn(() => "mock-random-string"),
}));

const EXPECTED_LOGO_URI = "https://www.mcpjam.com/mcp_jam_2row.png";

describe("OAuth client metadata logo_uri", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("MCPOAuthProvider includes logo_uri in clientMetadata", async () => {
    const { MCPOAuthProvider } = await import("../mcp-oauth");
    const provider = new MCPOAuthProvider(
      "test-server",
      "https://example.com/mcp",
    );
    expect(provider.clientMetadata).toHaveProperty(
      "logo_uri",
      EXPECTED_LOGO_URI,
    );
  });

  it("DebugMCPOAuthClientProvider includes logo_uri in clientMetadata", async () => {
    const { DebugMCPOAuthClientProvider } =
      await import("../debug-oauth-provider");
    const provider = new DebugMCPOAuthClientProvider("https://example.com");
    expect(provider.clientMetadata).toHaveProperty(
      "logo_uri",
      EXPECTED_LOGO_URI,
    );
  });
});
