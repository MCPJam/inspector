import { describe, expect, it } from "vitest";
import {
  analyzeAsCompatibility,
  detectVendor,
  JWT_BEARER_GRANT,
} from "../capability-preflight";

describe("detectVendor", () => {
  it("identifies okta tenants", () => {
    expect(detectVendor("https://dev-123.okta.com")).toBe("okta");
    expect(detectVendor("https://foo.oktapreview.com")).toBe("okta");
  });

  it("identifies workos / authkit", () => {
    expect(detectVendor("https://api.workos.com")).toBe("workos");
    expect(detectVendor("https://dynamic-echo-14-staging.authkit.app")).toBe(
      "workos",
    );
  });

  it("identifies stytch", () => {
    expect(detectVendor("https://test.stytch.com")).toBe("stytch");
  });

  it("identifies auth0", () => {
    expect(detectVendor("https://mytenant.auth0.com")).toBe("auth0");
  });

  it("identifies keycloak via realm path", () => {
    expect(
      detectVendor("https://sso.internal.corp/realms/mcpjam"),
    ).toBe("keycloak");
  });

  it("returns unknown for other issuers and for invalid URLs", () => {
    expect(detectVendor("https://example.com")).toBe("unknown");
    expect(detectVendor("not-a-url")).toBe("unknown");
    expect(detectVendor(undefined)).toBe("unknown");
  });
});

describe("analyzeAsCompatibility", () => {
  it("returns null when there is no metadata yet", () => {
    expect(analyzeAsCompatibility(undefined)).toBeNull();
  });

  it("passes when jwt-bearer is advertised and a token endpoint exists", () => {
    const report = analyzeAsCompatibility({
      issuer: "https://dev-123.okta.com",
      token_endpoint: "https://dev-123.okta.com/oauth2/v1/token",
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
        JWT_BEARER_GRANT,
      ],
    });
    expect(report?.overall).toBe("pass");
    expect(report?.vendor).toBe("okta");
    expect(report?.vendorHint?.verdict).toBe("native");
    const jwtCheck = report?.checks.find((c) => c.id === "jwt_bearer_grant");
    expect(jwtCheck?.status).toBe("pass");
  });

  it("fails when the AS doesn't advertise jwt-bearer", () => {
    const report = analyzeAsCompatibility({
      issuer: "https://dynamic-echo-14-staging.authkit.app",
      token_endpoint: "https://dynamic-echo-14-staging.authkit.app/oauth2/token",
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(report?.overall).toBe("fail");
    expect(report?.vendor).toBe("workos");
    expect(report?.vendorHint?.verdict).toBe("unsupported");
    const jwtCheck = report?.checks.find((c) => c.id === "jwt_bearer_grant");
    expect(jwtCheck?.status).toBe("fail");
  });

  it("warns when grant_types_supported is missing from metadata", () => {
    const report = analyzeAsCompatibility({
      issuer: "https://mytenant.auth0.com",
      token_endpoint: "https://mytenant.auth0.com/oauth/token",
    });
    expect(report?.overall).toBe("warn");
    expect(report?.vendor).toBe("auth0");
    const jwtCheck = report?.checks.find((c) => c.id === "jwt_bearer_grant");
    expect(jwtCheck?.status).toBe("unknown");
  });

  it("overrides overall to fail when the vendor is known-unsupported, even with missing metadata", () => {
    const report = analyzeAsCompatibility({
      issuer: "https://dynamic-echo-14-staging.authkit.app",
      token_endpoint: "https://dynamic-echo-14-staging.authkit.app/oauth2/token",
    });
    expect(report?.overall).toBe("fail");
    expect(report?.vendorHint?.vendor).toBe("workos");
  });

  it("flags missing token endpoint", () => {
    const report = analyzeAsCompatibility({
      issuer: "https://dev-123.okta.com",
      token_endpoint: "",
      grant_types_supported: [JWT_BEARER_GRANT],
    });
    expect(report?.overall).toBe("fail");
    const tokenCheck = report?.checks.find((c) => c.id === "token_endpoint");
    expect(tokenCheck?.status).toBe("fail");
  });

  it("treats an explicitly empty grant_types_supported as fail, not unknown", () => {
    // An AS that returns an empty array has made a positive declaration
    // (it supports no grants), which is different from omitting the field.
    const report = analyzeAsCompatibility({
      issuer: "https://dev-123.okta.com",
      token_endpoint: "https://dev-123.okta.com/oauth2/v1/token",
      grant_types_supported: [],
    });
    expect(report?.overall).toBe("fail");
    const jwtCheck = report?.checks.find((c) => c.id === "jwt_bearer_grant");
    expect(jwtCheck?.status).toBe("fail");
    expect(jwtCheck?.detail).toContain("empty array");
  });

  it("relies entirely on the provided issuer for vendor detection", () => {
    // Regression: the state machine must pass its resolvedIssuer (not raw
    // metadata.issuer, which may be absent) into this function, otherwise
    // vendor hints are silently lost and WorkOS-known-unsupported would
    // quietly show as warn instead of fail.
    const report = analyzeAsCompatibility({
      issuer: "https://dynamic-echo-14-staging.authkit.app",
      token_endpoint: "https://dynamic-echo-14-staging.authkit.app/oauth2/token",
    });
    expect(report?.vendor).toBe("workos");
    expect(report?.vendorHint?.verdict).toBe("unsupported");
    expect(report?.overall).toBe("fail");
  });
});

describe("draft-04 profile + CIMD advertisement checks", () => {
  const base = {
    issuer: "https://auth.example.com",
    token_endpoint: "https://auth.example.com/oauth/token",
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
  };
  const check = (metadata: any, id: string) =>
    analyzeAsCompatibility(metadata)?.checks.find((c) => c.id === id);

  it("passes when the ID-JAG profile is advertised", () => {
    const result = check(
      {
        ...base,
        authorization_grant_profiles_supported: [
          "urn:ietf:params:oauth:grant-profile:id-jag",
        ],
      },
      "id_jag_profile"
    );
    expect(result?.status).toBe("pass");
  });

  it("fails only on an explicit profile list without ID-JAG", () => {
    const contradicted = analyzeAsCompatibility({
      ...base,
      authorization_grant_profiles_supported: ["urn:other:profile"],
    });
    expect(
      contradicted?.checks.find((c) => c.id === "id_jag_profile")?.status
    ).toBe("fail");
    // An explicit contradiction degrades the overall verdict...
    expect(contradicted?.overall).toBe("fail");

    // ...but an absent advertisement is a SHOULD-level warning that does NOT
    // degrade an otherwise-passing server.
    const absent = analyzeAsCompatibility(base);
    expect(absent?.checks.find((c) => c.id === "id_jag_profile")?.status).toBe(
      "warn"
    );
    expect(absent?.overall).toBe("pass");
  });

  it("classifies cimd_supported without affecting the overall verdict", () => {
    expect(
      check({ ...base, client_id_metadata_document_supported: true }, "cimd_supported")
        ?.status
    ).toBe("pass");
    const explicitFalse = analyzeAsCompatibility({
      ...base,
      client_id_metadata_document_supported: false,
    });
    expect(
      explicitFalse?.checks.find((c) => c.id === "cimd_supported")?.status
    ).toBe("fail");
    expect(explicitFalse?.overall).toBe("pass");
    expect(check(base, "cimd_supported")?.status).toBe("unknown");
  });
});
