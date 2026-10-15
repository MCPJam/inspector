import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
import { authFetch } from "@/lib/session-token";
import {
  buildStoredOAuthConfig,
  handleOAuthCallback,
  serializeStoredOAuthConfig,
} from "../mcp-oauth";

describe("OAuth recovery security boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });
  it("replaces a stale header flag and serializes public settings as ordinary JSON", () => {
    const config = buildStoredOAuthConfig({
      customHeaders: { Authorization: "Bearer transport" },
      scopes: ["read"],
    });
    expect(config.hasCustomHeaders).toBe(false);
    expect(JSON.parse(serializeStoredOAuthConfig(config))).toEqual({
      scopes: ["read"],
      useRegistryOAuthProxy: false,
    });
    expect(serializeStoredOAuthConfig(config)).not.toContain("transport");
  });
  it.each([
    { callbackState: "wrong", callbackIss: "https://issuer.example" },
    { callbackState: "expected", callbackIss: "https://wrong.example" },
  ])(
    "rejects $callbackState/$callbackIss before consuming recovery headers",
    async (callback) => {
      localStorage.setItem("mcp-oauth-pending", "server");
      localStorage.setItem("mcp-serverUrl-server", "https://example.com/mcp");
      localStorage.setItem(
        "mcp-oauth-config-server",
        JSON.stringify({ hasCustomHeaders: true }),
      );
      localStorage.setItem(
        "mcp-oauth-flow-state-server",
        JSON.stringify({
          version: 1,
          protocolVersion: "2026-07-28",
          registrationStrategy: "dcr",
          state: {
            state: "expected",
            recordedIssuer: "https://issuer.example",
            authorizationServerMetadata: {
              issuer: "https://issuer.example",
              authorization_response_iss_parameter_supported: true,
            },
          },
        }),
      );
      sessionStorage.setItem(
        "mcp-oauth-recovery-handle-server",
        "a".repeat(48),
      );
      const result = await handleOAuthCallback("code", callback);
      expect(result.success).toBe(false);
      expect(authFetch).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("mcp-oauth-recovery-handle-server")).toBe(
        "a".repeat(48),
      );
      expect(
        localStorage.getItem("mcp-oauth-flow-state-server"),
      ).not.toBeNull();
      expect(localStorage.getItem("mcp-oauth-pending")).toBe("server");
    },
  );
});
