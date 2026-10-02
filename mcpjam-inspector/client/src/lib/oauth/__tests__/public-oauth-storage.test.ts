import { describe, expect, it } from "vitest";
import {
  assertPublicOAuthUrl,
  publicClientInformation,
  publicDiscoveryState,
  sanitizeStoredClientInformation,
} from "../public-oauth-storage";

describe("public OAuth recovery storage", () => {
  it("keeps identity/auth hints, not credentials or arbitrary extensions", () => {
    expect(
      publicClientInformation({
        client_id: "public-client",
        token_endpoint_auth_method: "client_secret_post",
        client_id_issued_at: 123,
        client_secret_expires_at: 456,
        client_secret: "dummy-secret",
        registration_access_token: "dummy-management-token",
        jwks: { keys: [{ d: "dummy-private-key" }] },
        extension: { access_token: "dummy-token" },
      }),
    ).toEqual({
      client_id: "public-client",
      token_endpoint_auth_method: "client_secret_post",
      client_id_issued_at: 123,
      client_secret_expires_at: 456,
    });
  });

  it("rebuilds the complete issuer envelope and every bucket", () => {
    const bucket = {
      client_id: "public",
      client_secret: "dummy-secret",
      registration_access_token: "dummy-token",
    };
    const raw = sanitizeStoredClientInformation(
      JSON.stringify({
        v: 2,
        activeIssuer: "https://a.example",
        client_secret: "dummy-root",
        extension: { secret: "dummy-extension" },
        byIssuer: { "https://a.example": bucket, "https://b.example": bucket },
      }),
    );
    expect(JSON.parse(raw!)).toEqual({
      v: 2,
      activeIssuer: "https://a.example",
      byIssuer: {
        "https://a.example": { client_id: "public" },
        "https://b.example": { client_id: "public" },
      },
    });
    expect(sanitizeStoredClientInformation(raw)).toBe(raw);
    expect(sanitizeStoredClientInformation("broken")).toBeNull();
    expect(sanitizeStoredClientInformation(JSON.stringify(bucket))).toBe(
      JSON.stringify({ client_id: "public" }),
    );
  });

  it("keeps public discovery capabilities but drops response extensions", () => {
    const state = publicDiscoveryState({
      authorizationServerUrl: "https://as.example",
      authorizationServerMetadata: {
        issuer: "https://as.example",
        authorization_endpoint: "https://as.example/auth",
        token_endpoint: "https://as.example/token",
        scopes_supported: ["read"],
        client_id_metadata_document_supported: true,
        extension: { access_token: "dummy-token" },
      },
      resourceMetadata: {
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://as.example"],
        access_token: "dummy-token",
      },
      clientSecret: "dummy-secret",
    } as any);
    expect(JSON.stringify(state)).not.toContain("dummy");
    expect(state.authorizationServerMetadata).toMatchObject({
      scopes_supported: ["read"],
      client_id_metadata_document_supported: true,
    });
    expect(state.resourceMetadata?.authorization_servers).toEqual([
      "https://as.example",
    ]);
  });

  it.each([
    "https://user:dummy-password@mcp.example/mcp",
    "https://mcp.example/mcp?api_key=dummy-token",
    "https://mcp.example/mcp?Access-Token=dummy-token",
    "https://mcp.example/mcp?X-Amz-Signature=dummy-token",
    "https://mcp.example/mcp#dummy-token",
  ])(
    "rejects credential-bearing recovery URLs without echoing them: %s",
    (url) => {
      expect(() => assertPublicOAuthUrl(url)).toThrow(
        "must not contain credentials",
      );
      try {
        assertPublicOAuthUrl(url);
      } catch (error) {
        expect(String(error)).not.toContain("dummy");
      }
      expect(() =>
        publicDiscoveryState({ authorizationServerUrl: url } as any),
      ).toThrow();
    },
  );

  it("preserves ordinary URL parameters exactly", () => {
    expect(() =>
      assertPublicOAuthUrl("https://mcp.example/mcp?region=us&version=2"),
    ).not.toThrow();
  });
});
