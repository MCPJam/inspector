import { describe, expect, it } from "vitest";
import {
  buildDiscoveryCandidates,
  evaluateDiscovery,
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
