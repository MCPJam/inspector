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
      useServerForm(undefined, { requireHttps: true })
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

  it("retains bearer authorization headers even without custom headers", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Bearer server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("bearer");
      result.current.setBearerToken("secret-token");
    });

    expect(result.current.buildFormData()).toMatchObject({
      name: "Bearer server",
      type: "http",
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer secret-token",
      },
    });
  });

  it("marks prefilled stdio env vars as a secret patch", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Prefilled stdio");
      result.current.setType("stdio");
      result.current.setCommandInput("node server.js");
      result.current.setEnvVars([{ key: "API_TOKEN", value: "secret" }]);
    });

    expect(result.current.buildFormData()).toMatchObject({
      env: { API_TOKEN: "secret" },
      secretPatch: {
        env: { API_TOKEN: "secret" },
      },
    });
  });

  it("does not replace hidden stored headers when editing auth without reveal", async () => {
    const server = {
      name: "Hidden header server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredHeaders).toBe(true);
    });

    act(() => {
      result.current.setAuthType("bearer");
      result.current.setBearerToken("new-token");
    });

    expect(result.current.buildFormData()).toMatchObject({
      headers: { Authorization: "Bearer new-token" },
    });
    expect(result.current.buildFormData().secretPatch?.headers).toBeUndefined();
    expect(result.current.validateForm()).toBe(
      "Reveal saved headers before changing authentication so existing hidden headers aren't lost."
    );
  });

  it("keeps revealed Bearer Authorization as a custom header without changing auth type", async () => {
    const server = {
      name: "Revealed header server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredHeaders).toBe(true);
    });

    act(() => {
      result.current.revealStoredHeaders({
        Authorization: "Bearer old-token",
        "X-Api-Key": "secret",
      });
    });

    expect(result.current.authType).toBe("none");
    expect(result.current.bearerToken).toBe("");
    expect(result.current.customHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "Authorization",
          value: "Bearer old-token",
        }),
        expect.objectContaining({ key: "X-Api-Key", value: "secret" }),
      ])
    );
    expect(result.current.validateForm()).toBeNull();
    expect(result.current.buildFormData()).toMatchObject({
      headers: {
        Authorization: "Bearer old-token",
        "X-Api-Key": "secret",
      },
    });
    expect(result.current.buildFormData().secretPatch?.headers).toBeUndefined();
  });

  it("sends a replacement header patch after revealed headers are edited", async () => {
    const server = {
      name: "Edited revealed header server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredHeaders).toBe(true);
    });

    act(() => {
      result.current.revealStoredHeaders({
        Authorization: "Bearer old-token",
        "X-Api-Key": "secret",
      });
    });

    act(() => {
      result.current.updateCustomHeader(0, "value", "Bearer new-token");
    });

    expect(result.current.validateForm()).toBeNull();
    expect(result.current.buildFormData()).toMatchObject({
      secretPatch: {
        headers: {
          Authorization: "Bearer new-token",
          "X-Api-Key": "secret",
        },
      },
    });
  });

  it("preserves non-Bearer Authorization headers when revealing stored headers", async () => {
    const server = {
      name: "Basic auth server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredHeaders).toBe(true);
    });

    act(() => {
      result.current.revealStoredHeaders({
        Authorization: "Basic abc123",
        "X-Api-Key": "secret",
      });
    });

    expect(result.current.authType).toBe("none");
    expect(result.current.customHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "Authorization",
          value: "Basic abc123",
        }),
        expect.objectContaining({ key: "X-Api-Key", value: "secret" }),
      ])
    );
    expect(result.current.buildFormData()).toMatchObject({
      headers: {
        Authorization: "Basic abc123",
        "X-Api-Key": "secret",
      },
    });
    expect(result.current.buildFormData().secretPatch?.headers).toBeUndefined();
  });

  it("includes an exact client capabilities override when enabled", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Capabilities test");
      result.current.setType("stdio");
      result.current.setCommandInput(
        "npx -y @modelcontextprotocol/server-test"
      );
      result.current.setClientCapabilitiesOverrideEnabled(true);
      result.current.setClientCapabilitiesOverrideText(
        JSON.stringify(
          {
            roots: { listChanged: true },
          },
          null,
          2
        )
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
      })
    );

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.oauthProtocolMode).toBe("2025-11-25");
    });

    localStorage.removeItem("mcp-oauth-config-Existing OAuth server");
  });

  it("normalizes invalid stored OAuth registration strategies back to auto", async () => {
    const server = {
      name: "Existing OAuth server",
      config: {
        url: "https://example.com/mcp",
      },
      useOAuth: true,
      oauthFlowProfile: {
        protocolVersion: "2025-11-25",
        registrationStrategy: "corrupted-value",
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.oauthRegistrationMode).toBe("auto");
    });
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

  it("represents a stored client secret without exposing the value", async () => {
    const server = {
      name: "Stored secret server",
      config: {
        url: "https://example.com/mcp",
      },
      useOAuth: true,
      hasClientSecret: true,
      oauthFlowProfile: {
        serverUrl: "https://example.com/mcp",
        clientId: "client-id",
        clientSecret: "",
        scopes: "",
        customHeaders: [],
        protocolVersion: "2025-11-25",
        registrationStrategy: "preregistered",
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredClientSecret).toBe(true);
    });

    expect(result.current.clientSecret).toBe("");
    expect(result.current.buildFormData()).toMatchObject({
      clientId: "client-id",
      hasClientSecret: true,
      clearClientSecret: false,
    });
    expect(result.current.buildFormData().clientSecret).toBeUndefined();
  });

  it("marks a stored client secret for clearing without sending a secret", async () => {
    const server = {
      name: "Stored secret server",
      config: {
        url: "https://example.com/mcp",
      },
      useOAuth: true,
      hasClientSecret: true,
      oauthFlowProfile: {
        serverUrl: "https://example.com/mcp",
        clientId: "client-id",
        clientSecret: "",
        scopes: "",
        customHeaders: [],
        protocolVersion: "2025-11-25",
        registrationStrategy: "preregistered",
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredClientSecret).toBe(true);
    });

    act(() => {
      result.current.setClearClientSecret(true);
    });

    expect(result.current.buildFormData()).toMatchObject({
      hasClientSecret: false,
      clearClientSecret: true,
    });
    expect(result.current.buildFormData().clientSecret).toBeUndefined();
  });
});
