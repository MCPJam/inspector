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
  it("defaults OAuth protocol mode to explicit latest", () => {
    const { result } = renderHook(() => useServerForm());

    expect(result.current.oauthProtocolMode).toBe("2025-11-25");
  });

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

  it("normalizes legacy automatic OAuth protocol mode to explicit latest for existing servers", async () => {
    const server = {
      name: "Existing OAuth server",
      config: {
        url: "https://example.com/mcp",
      },
      useOAuth: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    localStorage.setItem(
      "mcp-oauth-config-Existing OAuth server",
      JSON.stringify({
        protocolMode: "auto",
      }),
    );

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.oauthProtocolMode).toBe("2025-11-25");
    });

    localStorage.removeItem("mcp-oauth-config-Existing OAuth server");
  });

  it("blocks submit for preregistered OAuth until client ID passes validation", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setType("http");
      result.current.setAuthType("oauth");
      result.current.setOauthRegistrationMode("preregistered");
    });

    expect(result.current.preregisteredOauthBlocksSubmit).toBe(true);

    act(() => {
      result.current.setClientId("ab");
    });
    expect(result.current.preregisteredOauthBlocksSubmit).toBe(true);

    act(() => {
      result.current.setClientId("abc");
    });
    expect(result.current.preregisteredOauthBlocksSubmit).toBe(false);
  });

  it("does not set preregisteredOauthBlocksSubmit for non-HTTP transports", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setType("stdio");
      result.current.setAuthType("oauth");
      result.current.setOauthRegistrationMode("preregistered");
    });

    expect(result.current.preregisteredOauthBlocksSubmit).toBe(false);
  });
});
