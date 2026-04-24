import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-app-state", () => ({}));
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
  getStoredTokens: vi.fn().mockReturnValue(null),
}));

import { useServerForm } from "../use-server-form";

describe("useServerForm", () => {
  it("rejects malformed HTTP URLs even when HTTPS is optional", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Test server");
      result.current.setUrl("foo");
    });

    expect(result.current.validateForm()).toBe("Invalid URL format");
  });

  it("allows valid HTTP URLs when HTTPS is not required", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Test server");
      result.current.setUrl("http://example.com/mcp");
    });

    expect(result.current.validateForm()).toBeNull();
  });

  it("still enforces HTTPS when explicitly required", () => {
    const { result } = renderHook(() =>
      useServerForm(undefined, { requireHttps: true }),
    );

    act(() => {
      result.current.setName("Test server");
      result.current.setUrl("http://example.com/mcp");
    });

    expect(result.current.validateForm()).toBe("HTTPS is required");
  });

  it("includes OAuth protocol and registration overrides in built HTTP form data", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Planner test");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("oauth");
      result.current.setShowAuthSettings(true);
      result.current.setOauthProtocolMode("2025-06-18");
      result.current.setOauthRegistrationMode("dcr");
      result.current.setOauthScopesInput("openid profile");
    });

    expect(result.current.buildFormData()).toMatchObject({
      name: "Planner test",
      type: "http",
      url: "https://example.com/mcp",
      useOAuth: true,
      oauthProtocolMode: "2025-06-18",
      oauthRegistrationMode: "dcr",
      oauthScopes: ["openid", "profile"],
    });
  });
});
