import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-app-state", () => ({}));
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
  getStoredTokens: vi.fn().mockReturnValue(null),
}));

import { useServerForm } from "../use-server-form";
import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";

describe("useServerForm", () => {
  beforeEach(() => {
    vi.mocked(hasOAuthConfig).mockReturnValue(false);
  });

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

  it("asks for stored headers when editing auth with hidden headers and merges them into the patch", async () => {
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

    // Without the stored headers the form can't build a safe replacement
    // patch, so it withholds one and flags that a reveal is needed.
    expect(result.current.needsStoredHeaderReveal).toBe(true);
    expect(result.current.buildFormData().secretPatch?.headers).toBeUndefined();
    expect(result.current.validateForm()).toBeNull();

    // With the stored headers supplied at save time, the patch swaps the
    // Authorization header and keeps the rest.
    expect(
      result.current.buildFormData({
        revealedHeaders: {
          Authorization: "Bearer old-token",
          "X-Api-Key": "secret",
        },
      })
    ).toMatchObject({
      headers: {
        Authorization: "Bearer new-token",
        "X-Api-Key": "secret",
      },
      secretPatch: {
        headers: {
          Authorization: "Bearer new-token",
          "X-Api-Key": "secret",
        },
      },
    });
  });

  it("keeps the hidden Authorization header when only header rows change", async () => {
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
      result.current.addCustomHeader();
    });
    act(() => {
      result.current.updateCustomHeader(0, "key", "X-New");
    });
    act(() => {
      result.current.updateCustomHeader(0, "value", "fresh");
    });

    expect(result.current.needsStoredHeaderReveal).toBe(true);
    expect(
      result.current.buildFormData({
        revealedHeaders: {
          Authorization: "Bearer keep-me",
          "X-Api-Key": "secret",
        },
      }).secretPatch
    ).toEqual({
      headers: {
        Authorization: "Bearer keep-me",
        "X-Api-Key": "secret",
        "X-New": "fresh",
      },
    });
  });

  it("drops the hidden Authorization header when auth switches away from bearer", async () => {
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
      result.current.setAuthType("oauth");
    });

    expect(result.current.needsStoredHeaderReveal).toBe(true);
    expect(
      result.current.buildFormData({
        revealedHeaders: {
          Authorization: "Bearer old-token",
          "X-Api-Key": "secret",
        },
      }).secretPatch
    ).toEqual({
      headers: {
        "X-Api-Key": "secret",
      },
    });
  });

  it("sends a replacement header patch after stored headers are revealed", async () => {
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

    const authorizationHeaderIndex = result.current.customHeaders.findIndex(
      (header) => header.key === "Authorization"
    );
    expect(authorizationHeaderIndex).toBeGreaterThanOrEqual(0);

    act(() => {
      result.current.updateCustomHeader(
        authorizationHeaderIndex,
        "value",
        "Bearer new-token"
      );
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

  it("keeps OAuth selected when revealing a Bearer Authorization header", async () => {
    const server = {
      name: "OAuth server",
      config: {
        url: "https://example.com/mcp",
      },
      useOAuth: true,
      hasHeaders: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.authType).toBe("oauth");
    });
    await waitFor(() => {
      expect(result.current.hasStoredHeaders).toBe(true);
    });

    act(() => {
      result.current.revealStoredHeaders({
        Authorization: "Bearer oauth-access-token",
        "X-Api-Key": "secret",
      });
    });

    // Revealing stored headers must not silently switch auth away from OAuth.
    expect(result.current.authType).toBe("oauth");
    expect(result.current.bearerToken).toBe("");
    expect(result.current.customHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "Authorization",
          value: "Bearer oauth-access-token",
        }),
        expect.objectContaining({ key: "X-Api-Key", value: "secret" }),
      ])
    );
    expect(result.current.buildFormData()).toMatchObject({ useOAuth: true });
    // Revealing alone is not a pending change.
    expect(result.current.hasChanges).toBe(false);
  });

  it("treats a redacted hasBearerToken flag as a hidden bearer token", async () => {
    const server = {
      name: "Bearer server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      hasBearerToken: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.authType).toBe("bearer");
    });
    // Token value is stripped, but the form knows one is saved and stays clean.
    expect(result.current.bearerToken).toBe("");
    expect(result.current.hasStoredBearerToken).toBe(true);
    expect(result.current.hasChanges).toBe(false);
  });

  it("lets hidden bearer metadata win over stale stored OAuth config", async () => {
    vi.mocked(hasOAuthConfig).mockReturnValue(true);
    const server = {
      name: "Bearer server",
      config: {
        url: "https://example.com/mcp",
      },
      hasBearerToken: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.authType).toBe("bearer");
    });
    expect(result.current.hasStoredBearerToken).toBe(true);
    expect(result.current.hasStoredHeaders).toBe(true);
    expect(result.current.hasChanges).toBe(false);
  });

  it("reads redacted bearer and header flags from config metadata", async () => {
    const server = {
      name: "Runtime redacted bearer server",
      config: {
        url: "https://example.com/mcp",
        hasHeaders: true,
        hasBearerToken: true,
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.authType).toBe("bearer");
    });
    expect(result.current.hasStoredHeaders).toBe(true);
    expect(result.current.hasStoredBearerToken).toBe(true);
    expect(result.current.hasChanges).toBe(false);
  });

  it("preserves the hidden bearer token when saving an unrelated change", async () => {
    const server = {
      name: "Bearer server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      hasBearerToken: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredBearerToken).toBe(true);
    });

    act(() => {
      result.current.setName("Renamed server");
    });

    // Renaming touches neither auth nor headers, so no reveal is needed and no
    // header patch is sent — the backend keeps the saved Authorization header.
    expect(result.current.needsStoredHeaderReveal).toBe(false);
    const formData = result.current.buildFormData();
    expect(formData.secretPatch).toBeUndefined();
    expect(formData.headers).toBeUndefined();
  });

  it("reveals the stored bearer token into the bearer field", async () => {
    const server = {
      name: "Bearer server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      hasBearerToken: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredBearerToken).toBe(true);
    });

    act(() => {
      result.current.revealStoredHeaders({
        Authorization: "Bearer secret-token",
        "X-Api-Key": "secret",
      });
    });

    expect(result.current.authType).toBe("bearer");
    expect(result.current.bearerToken).toBe("secret-token");
    expect(result.current.hasStoredBearerToken).toBe(false);
    // Authorization moves to the bearer field, not the custom-header list.
    expect(
      result.current.customHeaders.some((h) => h.key === "Authorization")
    ).toBe(false);
    expect(result.current.customHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "X-Api-Key", value: "secret" }),
      ])
    );
    // Revealing alone is not a pending change.
    expect(result.current.hasChanges).toBe(false);
  });

  it("drops the hidden bearer token when switching to OAuth", async () => {
    const server = {
      name: "Bearer server",
      config: {
        url: "https://example.com/mcp",
      },
      hasHeaders: true,
      hasBearerToken: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.hasStoredBearerToken).toBe(true);
    });

    act(() => {
      result.current.setAuthType("oauth");
    });

    expect(result.current.needsStoredHeaderReveal).toBe(true);
    const formData = result.current.buildFormData({
      revealedHeaders: {
        Authorization: "Bearer old-token",
        "X-Api-Key": "secret",
      },
    });
    expect(formData.secretPatch).toEqual({
      headers: {
        "X-Api-Key": "secret",
      },
    });
    expect(formData.useOAuth).toBe(true);
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
