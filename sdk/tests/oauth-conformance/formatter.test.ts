import { readFileSync } from "node:fs";
import path from "node:path";
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

function stabilizeFixtureValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stabilizeFixtureValue(entry)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
      if (key === "timestamp" || key === "duration" || key === "durationMs") {
        return [key, 0];
      }

      return [key, stabilizeFixtureValue(entryValue)];
    }),
  ) as T;
}

function loadCapturedFailureFixture(): ConformanceResult {
  const fixturePath = path.join(
    __dirname,
    "../../../cli/src/error_example.txt",
  );
  const raw = readFileSync(fixturePath, "utf8").trim();
  const jsonLine = raw.split(/\r?\n/).slice(1).join("\n").trim();
  const parsed = JSON.parse(jsonLine) as ConformanceResult;
  return stabilizeFixtureValue(parsed);
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

  it("snapshots the captured Asana failure without the raw HTML blob", () => {
    const fixture = loadCapturedFailureFixture();

    const output = formatOAuthConformanceHuman(fixture);

    expect(output).not.toContain("<html>");
    expect(output).toMatchSnapshot();
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
});
