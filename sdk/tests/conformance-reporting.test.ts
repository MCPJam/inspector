import {
  renderConformanceReportJUnitXml,
  renderConformanceReportJson,
  toConformanceReport,
  type ConformanceReport,
} from "../src/conformance-reporting.js";
import type {
  MCPAppsConformanceResult,
  MCPAppsConformanceSuiteResult,
} from "../src/apps-conformance/index.js";
import type {
  MCPConformanceResult,
  MCPConformanceSuiteResult,
} from "../src/mcp-conformance/index.js";
import type {
  ConformanceResult as OAuthConformanceResult,
  OAuthConformanceSuiteResult,
} from "../src/oauth-conformance/index.js";

function createProtocolResult(
  overrides: Partial<MCPConformanceResult> = {},
): MCPConformanceResult {
  return {
    passed: false,
    serverUrl: "https://mcp.example.com/mcp",
    checks: [
      {
        id: "ping",
        category: "core",
        title: "Ping",
        description: "Ping the MCP server.",
        status: "failed",
        durationMs: 12,
        error: {
          message: "Ping failed",
          details: { status: 500 },
        },
      },
      {
        id: "tools-list",
        category: "tools",
        title: "Tools List",
        description: "List tools.",
        status: "skipped",
        durationMs: 0,
      },
    ],
    summary: "0/2 checks passed, 1 failed, 1 skipped",
    durationMs: 25,
    categorySummary: {
      core: { total: 1, passed: 0, failed: 1, skipped: 0 },
      protocol: { total: 0, passed: 0, failed: 0, skipped: 0 },
      tools: { total: 1, passed: 0, failed: 0, skipped: 1 },
      prompts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
      security: { total: 0, passed: 0, failed: 0, skipped: 0 },
      transport: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    ...overrides,
  };
}

function createProtocolSuiteResult(): MCPConformanceSuiteResult {
  return {
    name: "Protocol Suite",
    serverUrl: "https://mcp.example.com/mcp",
    passed: false,
    results: [
      { ...createProtocolResult({ passed: true, checks: [] }), label: "Run 1" },
      { ...createProtocolResult(), label: "Run 2" },
    ],
    summary: "1/2 conformance runs passed",
    durationMs: 50,
  };
}

function createOAuthResult(
  overrides: Partial<OAuthConformanceResult> = {},
): OAuthConformanceResult {
  return {
    passed: false,
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    serverUrl: "https://mcp.example.com/mcp",
    steps: [
      {
        step: "received_authorization_code",
        title: "Authorization Code Received",
        summary: "Validate the redirect back to the callback URL.",
        status: "failed",
        durationMs: 10,
        logs: [],
        httpAttempts: [
          {
            step: "received_authorization_code",
            timestamp: 0,
            request: {
              method: "GET",
              url: "https://auth.example.com/authorize",
              headers: {},
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "text/html" },
              body: "<html><body>Login</body></html>",
            },
            duration: 10,
          },
        ],
        error: {
          message: "Auto-consent is required for headless auth.",
          details: {
            accessToken: "secret-token",
          },
        },
        teachableMoments: ["Headless mode requires auto-consent."],
      },
      {
        step: "verify_list_tools",
        title: "List Tools",
        summary: "Verify MCP tools are reachable.",
        status: "skipped",
        durationMs: 0,
        logs: [],
        httpAttempts: [],
      },
    ],
    summary: "OAuth conformance failed.",
    durationMs: 20,
    ...overrides,
  };
}

function createOAuthSuiteResult(): OAuthConformanceSuiteResult {
  return {
    name: "OAuth Suite",
    serverUrl: "https://mcp.example.com/mcp",
    passed: false,
    results: [
      { ...createOAuthResult({ passed: true, steps: [] }), label: "dcr" },
      { ...createOAuthResult(), label: "preregistered" },
    ],
    summary: "1/2 flows passed.",
    durationMs: 40,
  };
}

function createAppsResult(
  overrides: Partial<MCPAppsConformanceResult> = {},
): MCPAppsConformanceResult {
  return {
    passed: true,
    target: "node server.js",
    checks: [
      {
        id: "ui-tools-present",
        category: "tools",
        title: "UI Tools Present",
        description: "At least one tool advertises UI metadata.",
        status: "passed",
        durationMs: 4,
      },
    ],
    summary: "1/1 checks passed, 0 failed, 0 skipped",
    durationMs: 4,
    categorySummary: {
      tools: { total: 1, passed: 1, failed: 0, skipped: 0 },
      resources: { total: 0, passed: 0, failed: 0, skipped: 0 },
    },
    discovery: {
      toolCount: 1,
      uiToolCount: 1,
      listedResourceCount: 1,
      listedUiResourceCount: 1,
      checkedUiResourceCount: 1,
    },
    ...overrides,
  };
}

function createAppsSuiteResult(): MCPAppsConformanceSuiteResult {
  return {
    name: "Apps Suite",
    target: "node server.js",
    passed: true,
    results: [
      { ...createAppsResult(), label: "Run 1" },
      { ...createAppsResult(), label: "Run 2" },
    ],
    summary: "All 2 conformance runs passed",
    durationMs: 8,
  };
}

describe("toConformanceReport", () => {
  it("adapts protocol single and suite results", () => {
    const single = toConformanceReport(createProtocolResult());
    const suite = toConformanceReport(createProtocolSuiteResult());

    expect(single.kind).toBe("protocol-conformance");
    expect(single.groups[0]?.cases[0]?.id).toBe("ping");
    expect(single.groups[0]?.cases[1]?.status).toBe("skipped");
    expect(suite.name).toBe("Protocol Suite");
    expect(suite.groups).toHaveLength(2);
    expect(suite.groups[1]?.title).toBe("Run 2");
  });

  it("adapts oauth single and suite results", () => {
    const single = toConformanceReport(createOAuthResult());
    const suite = toConformanceReport(createOAuthSuiteResult());

    expect(single.kind).toBe("oauth-conformance");
    expect(single.groups[0]?.title).toBe("2025-11-25/dcr");
    expect(single.groups[0]?.cases[0]?.output).toContain(
      "GET https://auth.example.com/authorize",
    );
    expect(suite.name).toBe("OAuth Suite");
    expect(suite.groups[1]?.title).toBe("preregistered");
  });

  it("adapts apps single and suite results", () => {
    const single = toConformanceReport(createAppsResult());
    const suite = toConformanceReport(createAppsSuiteResult());

    expect(single.kind).toBe("apps-conformance");
    expect(single.groups[0]?.target).toBe("node server.js");
    expect(single.groups[0]?.cases[0]?.category).toBe("tools");
    expect(suite.name).toBe("Apps Suite");
    expect(suite.groups).toHaveLength(2);
  });
});

describe("renderConformanceReportJson", () => {
  it("redacts sensitive values", () => {
    const report = toConformanceReport(createOAuthResult());
    const redacted = renderConformanceReportJson(report);

    expect(
      JSON.stringify(redacted),
    ).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).toContain("[REDACTED]");
  });
});

describe("renderConformanceReportJUnitXml", () => {
  it("renders failures and skipped cases across multiple groups", () => {
    const report: ConformanceReport = {
      schemaVersion: 1,
      kind: "protocol-conformance",
      name: "Protocol Suite",
      passed: false,
      durationMs: 50,
      groups: toConformanceReport(createProtocolSuiteResult()).groups,
    };

    const xml = renderConformanceReportJUnitXml(report);

    expect(xml).toContain('testsuites name="Protocol Suite"');
    expect(xml).toContain('testsuite name="Run 2"');
    expect(xml).toContain('<failure message="Ping failed">');
    expect(xml).toContain("<skipped/>");
  });
});
