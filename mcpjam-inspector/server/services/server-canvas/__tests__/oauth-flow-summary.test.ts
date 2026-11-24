import { describe, expect, it } from "vitest";
import {
  optionalOAuthFlowSummarySchema,
  parseOAuthFlowSummary,
} from "../oauth-flow-summary.js";

const SUMMARY = {
  completedAt: 1_700_000_000_000,
  issuer: "https://auth.example.test",
  protocolVersion: "2025-11-25",
  registrationStrategy: "cimd",
  resourceIndicatorSent: true,
  scopesRequested: ["read", "write"],
  scopesGranted: ["read"],
  issReturned: true,
  issValidated: true,
  refreshTokenIssued: true,
  tokenEndpointAuthMethod: "none",
};

describe("OAuth-flow summary validation", () => {
  it("accepts a summary", () => {
    expect(parseOAuthFlowSummary(SUMMARY)).toEqual(SUMMARY);
  });

  it("drops anything secret a client sent beside the summary", () => {
    const parsed = parseOAuthFlowSummary({
      ...SUMMARY,
      accessToken: "SECRET_ACCESS",
      refreshToken: "SECRET_REFRESH",
      clientSecret: "SECRET_CLIENT",
      codeVerifier: "SECRET_VERIFIER",
      state: "SECRET_STATE",
      code: "SECRET_CODE",
    });
    expect(parsed).toEqual(SUMMARY);
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET_/);
  });

  it("refuses a refresh token in place of the boolean, and unbounded values", () => {
    expect(
      parseOAuthFlowSummary({ ...SUMMARY, refreshTokenIssued: "SECRET_REFRESH" }),
    ).toBeUndefined();
    expect(
      parseOAuthFlowSummary({
        ...SUMMARY,
        scopesGranted: Array.from({ length: 65 }, (_, index) => `s${index}`),
      }),
    ).toBeUndefined();
    expect(
      parseOAuthFlowSummary({ ...SUMMARY, tokenEndpointAuthMethod: "a b" }),
    ).toBeUndefined();
    expect(parseOAuthFlowSummary({ ...SUMMARY, issuer: "not a url" })).toBeUndefined();
  });

  it("refuses exactly what the backend's validator refuses", () => {
    const refused = [
      { issuer: "https://auth.example.test/?tenant=a" },
      { issuer: "https://auth.example.test/#top" },
      { issuer: "https://user:pass@auth.example.test" },
      { issuer: "ftp://auth.example.test" },
      { issuer: `https://auth.example.test/${"a".repeat(512)}` },
      { scopesRequested: ["read write"] },
      { scopesGranted: ['say"hi'] },
      { scopesGranted: [""] },
      { scopesGranted: ["a".repeat(201)] },
      { tokenEndpointAuthMethod: "urn:custom" },
      { protocolVersion: "2025 11 25" },
    ];
    for (const change of refused) {
      expect(parseOAuthFlowSummary({ ...SUMMARY, ...change })).toBeUndefined();
    }
    expect(
      parseOAuthFlowSummary({
        ...SUMMARY,
        issuer: "http://127.0.0.1:9000/realms/dev",
        scopesGranted: ["a".repeat(200), "files:read", "https://scope.example/x"],
      }),
    ).toMatchObject({ scopesGranted: expect.arrayContaining(["files:read"]) });
  });

  it("reads an invalid summary on a request body as absent", () => {
    expect(optionalOAuthFlowSummarySchema.parse({ completedAt: "x" })).toBeUndefined();
    expect(optionalOAuthFlowSummarySchema.parse(undefined)).toBeUndefined();
  });
});
