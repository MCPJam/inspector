import { describe, expect, it } from "vitest";
import {
  buildAuthorizationServerMetadataCandidates,
  buildIssuerPublicationCandidates,
  buildProtectedResourceMetadataCandidates,
  canonicalizeMcpResource,
} from "../../src/xaa/discovery.js";

describe("canonicalizeMcpResource", () => {
  it("preserves the trailing slash and query, normalizes the origin", () => {
    expect(canonicalizeMcpResource("HTTPS://MCP.Example.com:443/mcp/?t=1")).toBe(
      "https://mcp.example.com/mcp/?t=1",
    );
    expect(canonicalizeMcpResource("https://mcp.example.com/mcp")).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(canonicalizeMcpResource("https://mcp.example.com")).toBe(
      "https://mcp.example.com/",
    );
  });

  it("returns the input unchanged when unparseable", () => {
    expect(canonicalizeMcpResource("not a url")).toBe("not a url");
  });
});

describe("buildProtectedResourceMetadataCandidates (RFC 9728)", () => {
  it("path resource: insertion (slash-preserving), append, then root", () => {
    expect(
      buildProtectedResourceMetadataCandidates("https://mcp.example.com/mcp/"),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/",
      "https://mcp.example.com/mcp/.well-known/oauth-protected-resource",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("root resource: single root candidate", () => {
    expect(
      buildProtectedResourceMetadataCandidates("https://mcp.example.com"),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("preserves the resource query in path-insertion candidates", () => {
    expect(
      buildProtectedResourceMetadataCandidates(
        "https://mcp.example.com/mcp/?tenant=acme",
      ),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/?tenant=acme",
      "https://mcp.example.com/mcp/.well-known/oauth-protected-resource?tenant=acme",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);

    expect(
      buildProtectedResourceMetadataCandidates(
        "https://mcp.example.com?tenant=acme",
      ),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource?tenant=acme",
    ]);
  });
});

describe("buildAuthorizationServerMetadataCandidates (RFC 8414 + OIDC)", () => {
  it("path issuer: OAuth-first, each doc type insertion/append/root", () => {
    expect(
      buildAuthorizationServerMetadataCandidates("https://as.example.com/tenant"),
    ).toEqual([
      "https://as.example.com/.well-known/oauth-authorization-server/tenant",
      "https://as.example.com/tenant/.well-known/oauth-authorization-server",
      "https://as.example.com/.well-known/oauth-authorization-server",
      "https://as.example.com/.well-known/openid-configuration/tenant",
      "https://as.example.com/tenant/.well-known/openid-configuration",
      "https://as.example.com/.well-known/openid-configuration",
    ]);
  });

  it("root issuer: one candidate per doc type", () => {
    expect(
      buildAuthorizationServerMetadataCandidates("https://as.example.com"),
    ).toEqual([
      "https://as.example.com/.well-known/oauth-authorization-server",
      "https://as.example.com/.well-known/openid-configuration",
    ]);
  });
});

describe("buildIssuerPublicationCandidates (OIDC config for JWKS)", () => {
  it("path issuer: openid-configuration insertion/append/root", () => {
    expect(
      buildIssuerPublicationCandidates("https://issuer.example.com/api/xaa"),
    ).toEqual([
      "https://issuer.example.com/.well-known/openid-configuration/api/xaa",
      "https://issuer.example.com/api/xaa/.well-known/openid-configuration",
      "https://issuer.example.com/.well-known/openid-configuration",
    ]);
  });
});
