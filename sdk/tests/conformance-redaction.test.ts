import { describe, it, expect } from "vitest";
import {
  REDACTED,
  redactConformanceReportForSharing,
  redactSharedServerUrl,
  redactUrlSecrets,
} from "../src/conformance-redaction.js";

/**
 * The shape these tests defend is the one a real OAuth conformance run
 * produces: `credentials` from `buildCredentials`, and per-step `httpAttempts`
 * whose requests carry an `Authorization` header and whose responses carry the
 * token payload.
 */
function oauthResultLike() {
  return {
    passed: true,
    outcome: "passed",
    serverUrl: "https://mcp.example.com/mcp",
    protocolVersion: "2025-11-25",
    summary: "All steps passed",
    credentials: {
      clientId: "client-abc",
      clientSecret: "sh_super_secret",
      accessToken: "at_live_value",
      refreshToken: "rt_live_value",
      tokenType: "Bearer",
      expiresIn: 3600,
    },
    steps: [
      {
        step: "exchanged_authorization_code",
        title: "Exchange authorization code",
        status: "passed",
        logs: [{ label: "token", data: { access_token: "at_live_value" } }],
        httpAttempts: [
          {
            request: {
              method: "POST",
              url: "https://as.example.com/token",
              headers: { authorization: "Bearer at_live_value" },
              body: "grant_type=authorization_code&code=ac_secret&client_secret=sh_super_secret",
            },
            response: {
              status: 200,
              body: { access_token: "at_live_value", token_type: "Bearer" },
            },
          },
        ],
      },
    ],
  };
}

describe("redactConformanceReportForSharing", () => {
  it("drops the credential bag a completed OAuth run leaves behind", () => {
    const out = redactConformanceReportForSharing({
      oauth: oauthResultLike(),
    }) as any;

    expect(out.oauth.credentials).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("at_live_value");
    expect(JSON.stringify(out)).not.toContain("rt_live_value");
    expect(JSON.stringify(out)).not.toContain("sh_super_secret");
  });

  it("drops raw HTTP evidence and untyped logs entirely", () => {
    const out = redactConformanceReportForSharing({
      oauth: oauthResultLike(),
    }) as any;

    expect(out.oauth.steps[0].httpAttempts).toBeUndefined();
    expect(out.oauth.steps[0].logs).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("ac_secret");
  });

  it("keeps everything a result page renders", () => {
    const out = redactConformanceReportForSharing({
      oauth: oauthResultLike(),
      protocol: {
        checks: [
          {
            id: "initialize-negotiates-version",
            title: "Initialize negotiates a protocol version",
            status: "failed",
            error: { message: "Server replied with an unknown version" },
          },
          { id: "skipped-one", status: "skipped", skipReason: "not-applicable" },
        ],
      },
    }) as any;

    expect(out.oauth.outcome).toBe("passed");
    expect(out.oauth.protocolVersion).toBe("2025-11-25");
    expect(out.oauth.steps[0].title).toBe("Exchange authorization code");
    expect(out.oauth.steps[0].status).toBe("passed");
    expect(out.protocol.checks[0].error.message).toBe(
      "Server replied with an unknown version"
    );
    expect(out.protocol.checks[1].skipReason).toBe("not-applicable");
  });

  it("redacts credential-shaped keys wherever they survive", () => {
    const out = redactConformanceReportForSharing({
      protocol: {
        checks: [
          {
            id: "some-check",
            details: {
              api_key: "ak_live",
              nested: { refreshToken: "rt_live", tokenType: "Bearer" },
            },
          },
        ],
      },
    }) as any;

    const details = out.protocol.checks[0].details;
    expect(details.api_key).toBe(REDACTED);
    expect(details.nested.refreshToken).toBe(REDACTED);
    // Describes a token without being one.
    expect(details.nested.tokenType).toBe("Bearer");
  });

  it("redacts a string `code` but never a JSON-RPC numeric one", () => {
    const out = redactConformanceReportForSharing({
      protocol: {
        checks: [
          {
            id: "error-shape",
            // The exact thing a report exists to explain — must survive.
            error: { code: -32601, message: "Method not found" },
            details: { code: "ac_authorization_code" },
          },
        ],
      },
    }) as any;

    expect(out.protocol.checks[0].error.code).toBe(-32601);
    expect(out.protocol.checks[0].error.message).toBe("Method not found");
    expect(out.protocol.checks[0].details.code).toBe(REDACTED);
  });

  it("scrubs secrets carried in URL strings", () => {
    const out = redactConformanceReportForSharing({
      protocol: {
        checks: [
          {
            id: "redirected",
            summary:
              "Redirected to https://app.example.com/callback?code=ac_secret&state=xyz",
          },
        ],
      },
    }) as any;

    const summary = out.protocol.checks[0].summary as string;
    expect(summary).not.toContain("ac_secret");
    expect(summary).toContain("state=xyz");
  });

  it("leaves a clean report byte-identical in the fields that matter", () => {
    const clean = {
      apps: { checks: [{ id: "a", title: "A", status: "passed" }] },
      tasks: { checks: [{ id: "t", title: "T", status: "not-applicable" }] },
    };
    expect(redactConformanceReportForSharing(clean)).toEqual(clean);
  });

  it("survives a cyclic-depth payload without throwing", () => {
    let deep: any = { id: "leaf" };
    for (let i = 0; i < 60; i++) deep = { nested: deep };
    expect(() => redactConformanceReportForSharing(deep)).not.toThrow();
  });
});

describe("redactSharedServerUrl", () => {
  it("strips an API key from the query while keeping the parameter name", () => {
    const out = redactSharedServerUrl("https://mcp.example.com/mcp?api_key=sk_live_1");
    expect(out).toContain("api_key=");
    expect(out).not.toContain("sk_live_1");
  });

  it("strips URL userinfo", () => {
    const out = redactSharedServerUrl("https://user:hunter2@mcp.example.com/mcp");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("user:");
    expect(out).toContain("mcp.example.com");
  });

  it("leaves an ordinary URL untouched", () => {
    const url = "https://mcp.example.com/mcp";
    expect(redactSharedServerUrl(url)).toBe(url);
  });

  it("returns non-URL strings unchanged", () => {
    expect(redactUrlSecrets("not a url at all")).toBe("not a url at all");
  });
});
