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

  it("defaults OAuth protocol mode to the deferred 'auto' sentinel", () => {
    // "auto" (not a concrete era) is what makes the wire-pin bridge reachable:
    // a fresh form defers its OAuth era to the server's MCP wire pin instead of
    // hard-pinning 2025-11-25 and stranding a 2026-pinned server on the 2025
    // flow. The submit path bakes it into a concrete era (see below).
    const { result } = renderHook(() => useServerForm());

    expect(result.current.oauthProtocolMode).toBe("auto");
  });

  describe("default OAuth protocol 'auto' → wire-pin submit bridge", () => {
    const startDefaultOAuthAdd = (result: {
      current: ReturnType<typeof useServerForm>;
    }) => {
      act(() => {
        result.current.setName("Draft server");
        result.current.setUrl("https://example.com/mcp");
        result.current.setAuthType("oauth");
        result.current.setShowAuthSettings(true);
        // Note: oauthProtocolMode is left at its "auto" default — the user
        // never touched the Protocol dropdown.
      });
    };

    it("bakes the 2026 OAuth flow when adding with a 2026-07-28 wire pin", () => {
      const { result } = renderHook(() => useServerForm());
      startDefaultOAuthAdd(result);

      expect(
        result.current.buildFormData({
          wireProtocolVersionOverride: "2026-07-28",
        })
      ).toMatchObject({
        useOAuth: true,
        oauthProtocolMode: "2026-07-28",
      });
    });

    it("keeps the 2025-11-25 default when there is no 2026 wire pin", () => {
      const { result } = renderHook(() => useServerForm());
      startDefaultOAuthAdd(result);

      expect(result.current.buildFormData()).toMatchObject({
        useOAuth: true,
        oauthProtocolMode: "2025-11-25",
      });
      expect(
        result.current.buildFormData({
          wireProtocolVersionOverride: "2025-11-25",
        }).oauthProtocolMode
      ).toBe("2025-11-25");
    });

    it("lets an explicit protocol selection win over a 2026 wire pin", () => {
      const { result } = renderHook(() => useServerForm());
      startDefaultOAuthAdd(result);
      act(() => {
        result.current.setOauthProtocolMode("2025-06-18");
      });

      expect(
        result.current.buildFormData({
          wireProtocolVersionOverride: "2026-07-28",
        }).oauthProtocolMode
      ).toBe("2025-06-18");
    });
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
      registrationMode: "dcr",
      oauthScopes: ["openid", "profile"],
    });
  });

  it("emits useXaa (not useOAuth) and the resource-AS credentials for the XAA auth type", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("XAA server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setShowAuthSettings(true);
      result.current.setClientId("resource-client-id");
      result.current.setOauthScopesInput("read:tools");
      result.current.setXaaAuthzIssuer("https://idp.example.com");
      result.current.setXaaSubject("alice");
      result.current.setXaaEmail("alice@example.com");
    });

    expect(result.current.buildFormData()).toMatchObject({
      name: "XAA server",
      type: "http",
      useXaa: true,
      useOAuth: false,
      authServerMode: "mcpjam",
      clientId: "resource-client-id",
      oauthScopes: ["read:tools"],
      xaaAuthzIssuer: "https://idp.example.com",
      xaaSubject: "alice",
      xaaEmail: "alice@example.com",
    });
  });

  it("does not require or emit preregistered credentials for explicit XAA CIMD", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("XAA CIMD server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setOauthRegistrationMode("cimd");
      result.current.setClientId("stale-preregistered-client");
      result.current.setClientSecret("stale-preregistered-secret");
    });

    expect(result.current.preregisteredOauthBlocksSubmit).toBe(false);
    expect(result.current.buildFormData()).toMatchObject({
      useXaa: true,
      registrationMode: "cimd",
      clientId: undefined,
      clientSecret: undefined,
      hasClientSecret: undefined,
      clearClientSecret: undefined,
    });
  });

  it("retains hidden preregistered credentials for explicit XAA DCR", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("XAA DCR server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setOauthRegistrationMode("dcr");
      result.current.setClientId("stored-preregistered-client");
      result.current.setClientSecret("stored-preregistered-secret");
    });

    expect(result.current.preregisteredOauthBlocksSubmit).toBe(false);
    expect(result.current.validateForm()).toBeNull();
    expect(result.current.authConfigurationBlocksSubmit).toBe(false);
    expect(result.current.buildFormData()).toMatchObject({
      useXaa: true,
      registrationMode: "dcr",
      clientId: "stored-preregistered-client",
      clientSecret: "stored-preregistered-secret",
      hasClientSecret: true,
    });
  });

  it("emits public CIMD without stored client credentials", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Public CIMD server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setOauthRegistrationMode("cimd");
      result.current.setXaaClientAuth("none");
      result.current.setClientId("stale-client");
      result.current.setClientSecret("stale-secret");
    });

    expect(result.current.validateForm()).toBeNull();
    const built = result.current.buildFormData();
    expect(built).toMatchObject({
      useXaa: true,
      registrationMode: "cimd",
      xaaClientAuth: "none",
    });
    expect(built.clientId).toBeUndefined();
    expect(built.clientSecret).toBeUndefined();
    expect(built.clearClientSecret).toBeUndefined();
  });

  it("rejects a short client secret for pre-registered XAA", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Pre-registered XAA server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setOauthRegistrationMode("preregistered");
      result.current.setClientId("resource-client-id");
      result.current.setClientSecret("short");
    });

    expect(result.current.validateForm()).toBe(
      "Client Secret must be at least 8 characters if provided"
    );
    expect(result.current.authConfigurationBlocksSubmit).toBe(true);
  });

  it("emits confidential CIMD when the local capability is available", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("Private CIMD server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setOauthRegistrationMode("cimd");
      result.current.setXaaClientAuth("private_key_jwt");
    });

    expect(result.current.confidentialCimdCapability.status).toBe("ready");
    expect(result.current.authConfigurationBlocksSubmit).toBe(false);
    expect(result.current.buildFormData()).toMatchObject({
      registrationMode: "cimd",
      xaaClientAuth: "private_key_jwt",
    });
  });

  it("omits the identity pair entirely when the override fields are untouched (no force-default)", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("XAA server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setClientId("resource-client-id");
    });

    // Untouched pair → BOTH keys omitted so the save path preserves stored
    // values; nothing is force-defaulted (to the signed-in user or anything
    // else).
    const built = result.current.buildFormData();
    expect(built.useXaa).toBe(true);
    expect("xaaSubject" in built).toBe(false);
    expect("xaaEmail" in built).toBe(false);
  });

  it("omits the identity pair on an untouched edit of a server with a stored override", async () => {
    const server = {
      name: "Saved XAA server",
      config: { url: "https://example.com/mcp" },
      useXaa: true,
      useOAuth: false,
      authServerMode: "mcpjam",
      clientId: "resource-client-id",
      xaaSubject: "stored-sub",
      xaaEmail: "stored@example.com",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));
    await waitFor(() => {
      expect(result.current.xaaSubject).toBe("stored-sub");
    });

    act(() => {
      result.current.setOauthScopesInput("read:tools");
    });

    // An unrelated edit leaves the identity pair untouched → omitted, so the
    // save path preserves the stored values instead of re-writing them.
    const built = result.current.buildFormData();
    expect("xaaSubject" in built).toBe(false);
    expect("xaaEmail" in built).toBe(false);
  });

  it("emits the complete trimmed pair when both override fields are edited", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("XAA server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setClientId("resource-client-id");
      result.current.setXaaSubject("  alice  ");
      result.current.setXaaEmail(" alice@example.com ");
    });

    expect(result.current.validateForm()).toBeNull();
    expect(result.current.buildFormData()).toMatchObject({
      xaaSubject: "alice",
      xaaEmail: "alice@example.com",
    });
  });

  it('emits "" for both fields on an explicit clear of a stored override', async () => {
    const server = {
      name: "Saved XAA server",
      config: { url: "https://example.com/mcp" },
      useXaa: true,
      useOAuth: false,
      authServerMode: "mcpjam",
      oauthFlowProfile: { clientId: "resource-client-id" },
      xaaSubject: "stored-sub",
      xaaEmail: "stored@example.com",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));
    await waitFor(() => {
      expect(result.current.xaaSubject).toBe("stored-sub");
    });

    act(() => {
      result.current.setXaaSubject("");
      result.current.setXaaEmail("");
    });

    expect(result.current.validateForm()).toBeNull();
    // The explicit empty pair reaches the backend, which normalizes it away.
    expect(result.current.buildFormData()).toMatchObject({
      xaaSubject: "",
      xaaEmail: "",
    });
  });

  it("blocks save with an actionable validation error on a partial identity pair", () => {
    const { result } = renderHook(() => useServerForm());

    act(() => {
      result.current.setName("XAA server");
      result.current.setUrl("https://example.com/mcp");
      result.current.setAuthType("xaa");
      result.current.setClientId("resource-client-id");
      result.current.setXaaSubject("alice");
    });

    expect(result.current.validateForm()).toBe(
      "Complete or clear the server identity override"
    );

    // Completing the pair clears the error…
    act(() => {
      result.current.setXaaEmail("alice@example.com");
    });
    expect(result.current.validateForm()).toBeNull();

    // …and so does clearing both.
    act(() => {
      result.current.setXaaSubject("");
      result.current.setXaaEmail("");
    });
    expect(result.current.validateForm()).toBeNull();
  });

  it("resolves an XAA server (useXaa, useOAuth false) to authType=xaa and never downgrades it to oauth on save", async () => {
    const server = {
      name: "Saved XAA server",
      config: { url: "https://example.com/mcp" },
      useXaa: true,
      useOAuth: false,
      authServerMode: "mcpjam",
      xaaAuthzIssuer: "https://idp.example.com",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.authType).toBe("xaa");
    });

    // The round-trip must keep it XAA — a silent rewrite to OAuth would be data
    // corruption (see CLAUDE.local.md resolvedAuthType guard).
    const built = result.current.buildFormData();
    expect(built.useXaa).toBe(true);
    expect(built.useOAuth).toBe(false);
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
      expect(result.current.registrationMode).toBe("auto");
    });
  });

  it("prefers the canonical registrationMode over the legacy concrete profile strategy", async () => {
    // A row saved by the unified pipeline: canonical "auto" plus the
    // rollback-compat concrete on the legacy profile field. The form must
    // show "auto" — preferring the concrete would rewrite the stored "auto"
    // on any unrelated edit (the Edit-form flavor of the auto-clobber bug).
    const server = {
      name: "Canonical auto server",
      config: {
        url: "https://example.com/mcp",
      },
      useOAuth: true,
      registrationMode: "auto",
      oauthFlowProfile: {
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    const { result } = renderHook(() => useServerForm(server));

    await waitFor(() => {
      expect(result.current.registrationMode).toBe("auto");
    });

    // An unrelated edit + save keeps emitting the canonical "auto".
    act(() => {
      result.current.setAuthType("oauth");
      result.current.setOauthScopesInput("openid");
    });
    expect(result.current.buildFormData()).toMatchObject({
      registrationMode: "auto",
    });
  });

  it("emits authMethod 'auto' with backend-mirrored derived booleans", async () => {
    // Auto on a server WITH sticky XAA config + a client id → selects XAA.
    const xaaConfigured = {
      name: "auto-xaa",
      config: { url: "https://example.com/mcp" },
      authMethod: "auto",
      authServerMode: "mcpjam",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;
    const { result } = renderHook(() => useServerForm(xaaConfigured));
    await waitFor(() => {
      expect(result.current.authType).toBe("auto");
    });
    act(() => {
      result.current.setClientId("client-1");
    });
    expect(result.current.buildFormData()).toMatchObject({
      authMethod: "auto",
      useXaa: true,
      useOAuth: false,
    });

    // Auto WITHOUT XAA config → selects OAuth.
    const { result: plain } = renderHook(() => useServerForm());
    act(() => {
      plain.current.setName("auto-oauth");
      plain.current.setUrl("https://example.com/mcp");
      plain.current.setAuthType("auto");
    });
    expect(plain.current.buildFormData()).toMatchObject({
      authMethod: "auto",
      useOAuth: true,
      useXaa: false,
    });
  });

  it("defaults new servers to Auto and emits it on save", () => {
    const { result } = renderHook(() => useServerForm());
    expect(result.current.authType).toBe("auto");

    act(() => {
      result.current.setName("brand-new");
      result.current.setUrl("https://example.com/mcp");
    });
    expect(result.current.buildFormData()).toMatchObject({
      authMethod: "auto",
      useOAuth: true,
      useXaa: false,
    });

    // resetForm restores the Auto default, not None.
    act(() => {
      result.current.setAuthType("bearer");
      result.current.resetForm();
    });
    expect(result.current.authType).toBe("auto");
  });

  it("sends clearXaaConfig only when explicitly moving off XAA", async () => {
    const xaaServer = {
      name: "was-xaa",
      config: { url: "https://example.com/mcp" },
      useXaa: true,
      authServerMode: "mcpjam",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
      enabled: true,
    } as any;

    // Switching to OAuth clears the sticky XAA identity config.
    const { result } = renderHook(() => useServerForm(xaaServer));
    await waitFor(() => {
      expect(result.current.authType).toBe("xaa");
    });
    act(() => {
      result.current.setAuthType("oauth");
    });
    expect(result.current.buildFormData()).toMatchObject({
      authMethod: "oauth",
      clearXaaConfig: true,
    });

    // Switching to "auto" preserves it — auto selects ON that config.
    const { result: toAuto } = renderHook(() => useServerForm(xaaServer));
    await waitFor(() => {
      expect(toAuto.current.authType).toBe("xaa");
    });
    act(() => {
      toAuto.current.setAuthType("auto");
    });
    const autoData = toAuto.current.buildFormData();
    expect(autoData.authMethod).toBe("auto");
    expect(autoData.clearXaaConfig).toBeUndefined();

    // Staying on XAA never sends the reset.
    const { result: stays } = renderHook(() => useServerForm(xaaServer));
    await waitFor(() => {
      expect(stays.current.authType).toBe("xaa");
    });
    const xaaData = stays.current.buildFormData();
    expect(xaaData.clearXaaConfig).toBeUndefined();
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
