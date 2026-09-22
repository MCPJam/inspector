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

describe("credentials that survived the first pass", () => {
  // Each of these was reachable before the gaps were closed: a shared report
  // could carry a live credential through them.

  it("redacts an access token in the URL FRAGMENT", () => {
    // The implicit flow puts the token after `#`, which is not in
    // `searchParams` — the densest credential spot a URL has.
    const out = redactUrlSecrets(
      "https://mcp.example.com/cb#access_token=ya29.live&token_type=bearer"
    );
    expect(out).not.toContain("ya29.live");
    // The parameter NAME is diagnostic and stays.
    expect(out).toContain("access_token=");
  });

  it("leaves a plain anchor alone", () => {
    const url = "https://docs.example.com/guide#section-2";
    expect(redactUrlSecrets(url)).toBe(url);
  });

  it("redacts a bare `Bearer <token>` with no header name", () => {
    const out = redactConformanceReportForSharing({
      summary: "retry failed, sent Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    });
    expect(JSON.stringify(out)).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts a Cookie header written into free text", () => {
    const out = redactConformanceReportForSharing({
      detail: "Cookie: session=abc123secret; other=1",
    });
    expect(JSON.stringify(out)).not.toContain("abc123secret");
  });

  it("redacts a token inside a JSON blob quoted in an error string", () => {
    const out = redactConformanceReportForSharing({
      error: 'token endpoint said {"access_token":"live-token-value","expires_in":3600}',
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("live-token-value");
    // Non-secret context survives, or the report stops being useful.
    expect(text).toContain("expires_in");
  });

  it("redacts a form-encoded client_secret that never parsed as a URL", () => {
    const out = redactConformanceReportForSharing({
      detail: "body was grant_type=authorization_code&client_secret=s3cr3t-value",
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("s3cr3t-value");
    expect(text).toContain("grant_type=authorization_code");
  });

  it("redacts query secrets in an embedded IPv6 URL", () => {
    // The bracketed authority previously ended the URL match at `[`.
    const out = redactConformanceReportForSharing({
      summary: "redirected to http://[::1]:8080/cb?code=auth-code-secret next",
    });
    expect(JSON.stringify(out)).not.toContain("auth-code-secret");
  });

  it("still does not swallow a closing bracket around a URL", () => {
    const out = redactConformanceReportForSharing({
      summary: "see [https://example.com/docs] for details",
    });
    expect(JSON.stringify(out)).toContain("https://example.com/docs]");
  });
});

describe("free-text credentials cubic flagged", () => {
  it("redacts a SHORT bearer token, not just a long one", () => {
    // A length floor only ever protected prose. `Bearer at-123` opens the same
    // door as a 200-character JWT.
    const out = redactConformanceReportForSharing({
      protocol: { checks: [{ id: "c", summary: "sent Bearer at-123" }] },
    }) as any;
    expect(out.protocol.checks[0].summary).not.toContain("at-123");
  });

  it("redacts Basic credentials", () => {
    const out = redactConformanceReportForSharing({
      protocol: {
        checks: [{ id: "c", summary: "retried with Basic dXNlcjpwYXNz" }],
      },
    }) as any;
    expect(out.protocol.checks[0].summary).not.toContain("dXNlcjpwYXNz");
  });

  it("redacts authorization and cookie inside a quoted JSON body", () => {
    const out = redactConformanceReportForSharing({
      protocol: {
        checks: [
          {
            id: "c",
            error: {
              message:
                'upstream said {"authorization": "Bearer at_live", "set-cookie": "sid=abc123"}',
            },
          },
        ],
      },
    }) as any;
    const message = out.protocol.checks[0].error.message as string;
    expect(message).not.toContain("at_live");
    expect(message).not.toContain("sid=abc123");
  });

  it("redacts a token inside an ESCAPED JSON document", () => {
    // A response body logged into a JSON string — the normal shape in a log.
    const out = redactConformanceReportForSharing({
      protocol: {
        checks: [
          { id: "c", summary: 'body was "{\\"access_token\\":\\"ey_live\\"}"' },
        ],
      },
    }) as any;
    expect(out.protocol.checks[0].summary).not.toContain("ey_live");
  });

  it("still leaves ordinary prose alone", () => {
    const clean = { protocol: { checks: [{ id: "c", summary: "Server returned 401 Unauthorized" }] } };
    expect(redactConformanceReportForSharing(clean)).toEqual(clean);
  });
});

describe("one credential predicate, not two lists", () => {
  // These were redacted as OBJECT FIELDS but published verbatim when the same
  // names appeared as quoted JSON in an error string — the free-text matcher
  // carried its own shorter list. Both now consult the same predicate.
  const cases: Array<[string, string]> = [
    ["code_verifier", "cv_live_value"],
    ["proxy-authorization", "Basic cHJveHk6cHc="],
    ["x-api-key", "xak_live_value"],
    ["registration_access_token", "rat_live_value"],
    ["client_assertion", "ca_live_value"],
    ["private_key", "pk_live_value"],
  ];

  for (const [key, secret] of cases) {
    it(`redacts "${key}" inside a quoted JSON body`, () => {
      const out = redactConformanceReportForSharing({
        protocol: {
          checks: [
            { id: "c", summary: `upstream said {"${key}": "${secret}"}` },
          ],
        },
      }) as any;
      expect(out.protocol.checks[0].summary).not.toContain(secret);
    });

    it(`redacts "${key}" in a form-encoded fragment`, () => {
      const out = redactConformanceReportForSharing({
        protocol: {
          checks: [{ id: "c", summary: `posted ${key}=${secret}&grant_type=x` }],
        },
      }) as any;
      const summary = out.protocol.checks[0].summary as string;
      expect(summary).not.toContain(secret);
      // Non-secret neighbours survive — the scrub is targeted, not scorched.
      expect(summary).toContain("grant_type=x");
    });
  }

  it("does not redact innocuous fields that merely sit nearby", () => {
    const clean = {
      protocol: {
        checks: [
          { id: "c", summary: 'got {"grant_type": "authorization_code", "expires_in": "3600"}' },
        ],
      },
    };
    expect(redactConformanceReportForSharing(clean)).toEqual(clean);
  });
});
