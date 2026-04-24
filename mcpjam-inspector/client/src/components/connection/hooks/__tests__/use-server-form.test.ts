import { act, renderHook, waitFor } from "@testing-library/react";
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

  it("includes an exact client capabilities override when enabled", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Capabilities test");
      result.current.setType("stdio");
      result.current.setCommandInput("npx -y @modelcontextprotocol/server-test");
      result.current.setClientCapabilitiesOverrideEnabled(true);
      result.current.setClientCapabilitiesOverrideText(
        JSON.stringify(
          {
            roots: { listChanged: true },
          },
          null,
          2,
        ),
      );
    });

    expect(result.current.buildFormData()).toMatchObject({
      name: "Capabilities test",
      type: "stdio",
      clientCapabilities: {
        roots: { listChanged: true },
      },
    });
  });

  it("auto-expands advanced settings for existing HTTP servers with custom headers", async () => {
    const server = {
      name: "Existing server",
      config: {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            "X-Test-Header": "present",
          },
        },
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.showConfiguration).toBe(true);
    });
  });
});
