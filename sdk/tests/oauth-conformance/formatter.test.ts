import {
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  type ConformanceResult,
  type OAuthConformanceSuiteResult,
} from "../../src/oauth-conformance/index.js";

function createPassingResult(
  overrides: Partial<ConformanceResult> = {},
): ConformanceResult {
  return {
    passed: true,
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    serverUrl: "https://mcp.example.com/mcp",
    steps: [
      {
        step: "request_without_token",
        title: "Initial MCP Request",
        summary:
          "The client sends an unauthenticated initialize request to discover whether OAuth is required.",
        status: "passed",
        durationMs: 12,
        logs: [],
        httpAttempts: [],
      },
    ],
    summary:
      "OAuth conformance passed for https://mcp.example.com/mcp (2025-11-25, dcr)",
    durationMs: 120,
    ...overrides,
  };
}

function createHtmlFailureResult(
  overrides: Partial<ConformanceResult> = {},
): ConformanceResult {
  return {
    passed: false,
    protocolVersion: "2025-06-18",
    registrationStrategy: "dcr",
    serverUrl: "https://mcp.example.com/mcp",
    steps: [
      {
        step: "request_without_token",
        title: "Initial MCP Request",
        summary:
          "The client sends an unauthenticated initialize request to discover whether OAuth is required.",
        status: "passed",
        durationMs: 4,
        logs: [],
        httpAttempts: [],
      },
      {
        step: "received_authorization_code",
        title: "Authorization Code Received",
        summary:
          "Inspector validates the redirect back to the callback URL and extracts the authorization code.",
        status: "failed",
        durationMs: 35,
        logs: [],
        http: {
          step: "received_authorization_code",
          timestamp: 1712700000000,
          request: {
            method: "GET",
            url: "https://auth.example.com/authorize?client_id=test-client",
            headers: {},
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
            body: `<!doctype html>
<html>
  <head>
    <title>Log in - Example</title>
    <style>body { color: red; }</style>
    <script>window.__BOOT__ = { giant: true };</script>
  </head>
  <body>
    <main>
      <h1>Welcome back</h1>
      <p>Please sign in to continue to Example.</p>
      <button>Continue with Google</button>
    </main>
  </body>
</html>`,
          },
          duration: 35,
        },
        httpAttempts: [
          {
            step: "received_authorization_code",
            timestamp: 1712700000000,
            request: {
              method: "GET",
              url: "https://auth.example.com/authorize?client_id=test-client",
              headers: {},
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
              body: `<!doctype html>
<html>
  <head><title>Log in - Example</title></head>
  <body><h1>Welcome back</h1><p>Please sign in to continue to Example.</p></body>
</html>`,
            },
            duration: 35,
          },
        ],
        error: {
          message:
            "Headless authorization requires auto-consent. The authorization endpoint returned a 200 response instead of redirecting back with a code.",
        },
        teachableMoments: [],
      },
    ],
    summary:
      "OAuth conformance failed at received_authorization_code: Headless authorization requires auto-consent. The authorization endpoint returned a 200 response instead of redirecting back with a code.",
    durationMs: 220,
    ...overrides,
  };
}

describe("OAuth conformance human formatter", () => {
  it("renders a compact summary for HTML failures without dumping the full body", () => {
    const result = createHtmlFailureResult();

    const output = formatOAuthConformanceHuman(result);

    expect(output).toContain("OAuth conformance: FAILED");
    expect(output).toContain("Step: received_authorization_code");
    expect(output).toContain("HTTP: 200 OK");
    expect(output).toContain(
      "URL: https://auth.example.com/authorize?client_id=test-client",
    );
    expect(output).toContain("Content-Type: text/html; charset=utf-8");
    expect(output).toContain("Page title: Log in - Example");
    expect(output).toContain(
      "Snippet: Welcome back Please sign in to continue to Example. Continue with Google",
    );
    expect(output).toContain(
      "Hint: Authorization endpoint returned an HTML login page instead of redirecting back to the callback URL.",
    );
    expect(output).not.toContain("<html>");
    expect(output).not.toContain("window.__BOOT__");
    expect(output).not.toContain("body { color: red; }");
  });

  it("does not mutate the raw result structure used by JSON consumers", () => {
    const result = createHtmlFailureResult();
    const before = structuredClone(result);

    formatOAuthConformanceHuman(result);

    expect(result).toEqual(before);
  });

  it("surfaces verification error messages alongside PASS/FAIL", () => {
    const result = createPassingResult({
      passed: false,
      verification: {
        listTools: {
          passed: false,
          durationMs: 50,
          error: "Server disconnected unexpectedly",
        },
        callTool: {
          passed: false,
          toolName: "execute_sql",
          durationMs: 20,
          error: "Tool returned error: invalid query",
        },
      },
      summary: "OAuth succeeded but verification failed",
    });

    const output = formatOAuthConformanceHuman(result);

    expect(output).toContain(
      "listTools: FAIL — Server disconnected unexpectedly",
    );
    expect(output).toContain(
      "callTool(execute_sql): FAIL — Tool returned error: invalid query",
    );
  });

  it("appends tool count to listTools PASS without dropping success text", () => {
    const result = createPassingResult({
      verification: {
        listTools: {
          passed: true,
          toolCount: 7,
          durationMs: 30,
        },
      },
    });

    const output = formatOAuthConformanceHuman(result);

    expect(output).toContain("listTools: PASS (7 tools)");
    expect(output).not.toContain("—");
  });

  it("prints a compact evidence line for failed OAuth checks", () => {
    const result = createPassingResult({
      passed: false,
      steps: [
        {
          step: "oauth_dcr_http_redirect_uri",
          title: "OAuth Check: DCR Redirect URI Policy",
          summary:
            "Attempt dynamic client registration with a non-loopback http redirect URI and confirm the authorization server rejects it.",
          status: "failed",
          durationMs: 18,
          logs: [],
          httpAttempts: [],
          error: {
            message:
              "Authorization server accepted a non-loopback http redirect_uri during dynamic client registration",
            details: {
              evidence:
                "Registered redirect_uri http://evil.example/callback was accepted and returned client_id evil-client.",
            },
          },
        },
      ],
      summary:
        "OAuth conformance failed at oauth_dcr_http_redirect_uri: Authorization server accepted a non-loopback http redirect_uri during dynamic client registration",
    });

    const output = formatOAuthConformanceHuman(result);

    expect(output).toContain("Step: oauth_dcr_http_redirect_uri");
    expect(output).toContain(
      "Evidence: Registered redirect_uri http://evil.example/callback was accepted and returned client_id evil-client.",
    );
  });

  it("redacts sensitive values before printing evidence", () => {
    const result = createPassingResult({
      passed: false,
      steps: [
        {
          step: "oauth_invalid_redirect",
          title: "OAuth Check: Invalid Redirect",
          summary: "Verify redirect URI validation.",
          status: "failed",
          durationMs: 12,
          logs: [],
          httpAttempts: [],
          error: {
            message: "Invalid redirect was accepted",
            details: {
              evidence:
                'Authorization: Bearer tok /?code=abc&access_token=xyz&id_token=id {"client_secret":"shh"}',
            },
          },
        },
      ],
      summary: "OAuth conformance failed at oauth_invalid_redirect",
    });

    const output = formatOAuthConformanceHuman(result);

    expect(output).toContain("Authorization: Bearer [REDACTED]");
    expect(output).toContain("code=[REDACTED]");
    expect(output).toContain("access_token=[REDACTED]");
    expect(output).toContain("id_token=[REDACTED]");
    expect(output).toContain('"client_secret":"[REDACTED]"');
    expect(output).not.toContain("Bearer tok");
    expect(output).not.toContain("code=abc");
    expect(output).not.toContain("access_token=xyz");
    expect(output).not.toContain("id_token=id");
    expect(output).not.toContain('"client_secret":"shh"');
  });
});

describe("OAuth conformance suite human formatter", () => {
  it("renders one compact line per flow and only expands failing flows", () => {
    const failure = createHtmlFailureResult({
      summary: "OAuth conformance failed at received_authorization_code",
    });
    const suite: OAuthConformanceSuiteResult = {
      name: "My OAuth Suite",
      serverUrl: "https://mcp.example.com/mcp",
      passed: false,
      results: [
        { ...createPassingResult(), label: "flow-1" },
        { ...createPassingResult(), label: "flow-2" },
        { ...failure, label: "flow-3" },
        { ...createPassingResult(), label: "flow-4" },
        { ...createPassingResult(), label: "flow-5" },
      ],
      summary: "4/5 flows passed. Failed: flow-3",
      durationMs: 510,
    };

    const output = formatOAuthConformanceSuiteHuman(suite);

    expect(output).toContain("OAuth conformance suite: FAILED");
    expect(output).toContain("PASS flow-1");
    expect(output).toContain("PASS flow-2");
    expect(output).toContain("FAIL flow-3");
    expect(output).toContain("PASS flow-4");
    expect(output).toContain("PASS flow-5");
    expect(output).toContain("[flow-3]");
    expect(output).toContain("Step: received_authorization_code");
    expect(output).toContain("Page title: Log in - Example");
    expect(output.match(/^PASS /gm)).toHaveLength(4);
    expect(output.match(/^FAIL /gm)).toHaveLength(1);
    expect(output.match(/^\[flow-/gm)).toHaveLength(1);
  });

  it("shows verification details for flows that fail only post-auth verification", () => {
    const verificationFailure: ConformanceResult = {
      ...createPassingResult(),
      passed: false,
      summary: "listTools verification failed",
      verification: {
        listTools: {
          passed: false,
          durationMs: 40,
          error: "MCP server closed connection",
        },
      },
    };

    const suite: OAuthConformanceSuiteResult = {
      name: "Verification-only failure",
      serverUrl: "https://mcp.example.com/mcp",
      passed: false,
      results: [{ ...verificationFailure, label: "flow-verify" }],
      summary: "0/1 flows passed. Failed: flow-verify",
      durationMs: 120,
    };

    const output = formatOAuthConformanceSuiteHuman(suite);

    expect(output).toContain("[flow-verify]");
    expect(output).toContain("Verification");
    expect(output).toContain(
      "listTools: FAIL — MCP server closed connection",
    );
  });
});
