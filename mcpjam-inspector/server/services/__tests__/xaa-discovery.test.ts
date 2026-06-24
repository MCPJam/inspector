import { describe, expect, it } from "vitest";
import {
  buildDiscoveryCandidates,
  buildResourceMetadataCandidates,
  evaluateDiscovery,
  extractAuthorizationServer,
  JWT_BEARER_GRANT,
} from "../xaa-discovery.js";

describe("buildDiscoveryCandidates", () => {
  it("covers path-insertion and root-append forms for a path-based issuer", () => {
    const candidates = buildDiscoveryCandidates(
      "https://login.example.com/realms/acme",
    );

    expect(candidates).toContain(
      "https://login.example.com/.well-known/openid-configuration/realms/acme",
    );
    expect(candidates).toContain(
      "https://login.example.com/.well-known/oauth-authorization-server/realms/acme",
    );
    expect(candidates).toContain(
      "https://login.example.com/realms/acme/.well-known/openid-configuration",
    );
    expect(candidates).toContain(
      "https://login.example.com/.well-known/openid-configuration",
    );
  });

  it("uses the root well-known forms for a bare-origin issuer", () => {
    const candidates = buildDiscoveryCandidates("https://issuer.example.com");

    expect(candidates).toEqual([
      "https://issuer.example.com/.well-known/openid-configuration",
      "https://issuer.example.com/.well-known/oauth-authorization-server",
    ]);
  });

  it("uses an explicit well-known URL verbatim", () => {
    const url = "https://issuer.example.com/.well-known/openid-configuration";
    expect(buildDiscoveryCandidates(url)).toEqual([url]);
  });
});

describe("buildResourceMetadataCandidates", () => {
  it("inserts the well-known segment before the resource path (RFC 9728 §3.1)", () => {
    expect(
      buildResourceMetadataCandidates("https://mcp.example.com/mcp"),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("uses the bare root form for a path-less resource", () => {
    expect(buildResourceMetadataCandidates("https://mcp.example.com")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });
});

describe("extractAuthorizationServer", () => {
  it("returns the first issuer from authorization_servers", () => {
    expect(
      extractAuthorizationServer({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: [
          "https://as.example.com",
          "https://other.example.com",
        ],
      }),
    ).toBe("https://as.example.com");
  });

  it("skips malformed entries and returns the first parseable issuer URL", () => {
    expect(
      extractAuthorizationServer({
        authorization_servers: ["not a url", "  ", "https://as.example.com"],
      }),
    ).toBe("https://as.example.com");
  });

  it("returns undefined when no authorization server is advertised", () => {
    expect(extractAuthorizationServer({ resource: "x" })).toBeUndefined();
    expect(
      extractAuthorizationServer({ authorization_servers: [] }),
    ).toBeUndefined();
    expect(
      extractAuthorizationServer({ authorization_servers: [""] }),
    ).toBeUndefined();
    expect(
      extractAuthorizationServer({ authorization_servers: ["not a url"] }),
    ).toBeUndefined();
  });
});

describe("evaluateDiscovery", () => {
  const metadataUrl = "https://as.example.com/.well-known/openid-configuration";

  it("passes when jwt-bearer is advertised and a token endpoint exists", () => {
    const verdict = evaluateDiscovery(
      {
        issuer: "https://as.example.com",
        token_endpoint: "https://as.example.com/oauth/token",
        grant_types_supported: [JWT_BEARER_GRANT, "authorization_code"],
      },
      { requestedIssuer: "https://as.example.com", metadataUrl },
    );

    expect(verdict.jwtBearerSupport).toBe("pass");
    expect(verdict.hasTokenEndpoint).toBe(true);
    expect(verdict.tokenEndpoint).toBe("https://as.example.com/oauth/token");
    expect(verdict.issuerMismatch).toBeNull();
  });

  it("warns when grant_types_supported is absent", () => {
    const verdict = evaluateDiscovery(
      { issuer: "https://as.example.com" },
      { requestedIssuer: "https://as.example.com", metadataUrl },
    );
    expect(verdict.jwtBearerSupport).toBe("warn");
  });

  it("fails when jwt-bearer is not in a non-empty grant list", () => {
    const verdict = evaluateDiscovery(
      {
        issuer: "https://as.example.com",
        grant_types_supported: ["authorization_code"],
      },
      { requestedIssuer: "https://as.example.com", metadataUrl },
    );
    expect(verdict.jwtBearerSupport).toBe("fail");
  });

  it("flags a scheme-only issuer mismatch (http advertised, https requested)", () => {
    const verdict = evaluateDiscovery(
      { issuer: "http://as.example.com" },
      { requestedIssuer: "https://as.example.com", metadataUrl },
    );

    expect(verdict.issuerMismatch).toEqual({
      requested: "https://as.example.com",
      advertised: "http://as.example.com",
      schemeOnly: true,
    });
  });

  it("flags a host/path issuer mismatch as not scheme-only", () => {
    const verdict = evaluateDiscovery(
      { issuer: "https://other.example.com" },
      { requestedIssuer: "https://as.example.com", metadataUrl },
    );

    expect(verdict.issuerMismatch?.schemeOnly).toBe(false);
  });
});
