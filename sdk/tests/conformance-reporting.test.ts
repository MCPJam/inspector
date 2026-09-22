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
import type { MCPTasksConformanceResult } from "../src/tasks-conformance/index.js";
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
    readiness: [],
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

describe("report outcome fields", () => {
  it("carries a single run's outcome and incompleteReason through", () => {
    const incomplete = toConformanceReport(
      createProtocolResult({
        passed: false,
        outcome: "incomplete",
        incompleteReason: "1 of 2 selected check(s) could not run",
      }),
    );

    expect(incomplete.outcome).toBe("incomplete");
    expect(incomplete.incompleteReason).toMatch(/could not run/);

    const failed = toConformanceReport(
      createProtocolResult({ passed: false, outcome: "failed" }),
    );
    expect(failed.outcome).toBe("failed");
    expect(failed.incompleteReason).toBeUndefined();
  });

  it("derives a suite outcome as the worst of its runs, failure outranking incomplete", () => {
    const suite = createProtocolSuiteResult();
    suite.results = [
      {
        ...createProtocolResult({ passed: true, checks: [], outcome: "passed" }),
        label: "Run 1",
      },
      {
        ...createProtocolResult({
          passed: false,
          outcome: "incomplete",
          incompleteReason: "probe unavailable",
        }),
        label: "Run 2",
      },
    ];

    const incompleteSuite = toConformanceReport(suite);
    expect(incompleteSuite.outcome).toBe("incomplete");
    expect(incompleteSuite.incompleteReason).toBe("probe unavailable");

    suite.results.push({
      ...createProtocolResult({ passed: false, outcome: "failed" }),
      label: "Run 3",
    });
    expect(toConformanceReport(suite).outcome).toBe("failed");
  });

  it("omits outcome for OAuth's not-applicable, which the report union does not carry", () => {
    const report = toConformanceReport(
      createOAuthResult({ passed: true, outcome: "not-applicable" }),
    );

    // Consumers keep the documented fallback: passed ? "passed" : "failed".
    expect(report.outcome).toBeUndefined();
    expect(report.passed).toBe(true);
  });
});

describe("report score", () => {
  it("scores every report kind, pooling suites over their runs", () => {
    const single = toConformanceReport(
      createProtocolResult({
        checks: [
          {
            id: "ping",
            category: "core",
            title: "Ping",
            description: "Ping.",
            status: "passed",
            durationMs: 1,
          },
        ],
        readiness: [
          {
            id: "readiness-metadata-quality",
            title: "Metadata Quality",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
          },
        ],
      } as Partial<MCPConformanceResult>),
    );

    // 1/1 applicable passed, one SHOULD advisory: 95 + (5 − 2) = 98.
    expect(single.score?.score).toBe(98);
    expect(single.score?.applicable).toBe(1);

    const suite = toConformanceReport(createProtocolSuiteResult());
    expect(suite.score).toBeDefined();
    expect(suite.score?.failed).toBeGreaterThan(0);
  });

  it("emits the score as properties inside each <testsuite>, never under the root", () => {
    const xml = renderConformanceReportJUnitXml(
      toConformanceReport(createAppsResult()),
    );

    expect(xml).toContain('<property name="mcpjam.conformance.score" value="100"/>');
    expect(xml).toContain('name="mcpjam.conformance.summary"');
    expect(xml).toContain('tests="1" failures="0" skipped="0"');
    // JUnit XSDs (Jenkins, Ant, Surefire) place <properties> under
    // <testsuite>; a root-level block is schema-invalid.
    expect(xml).toMatch(/<testsuite [^>]*>\n    <properties>/);
    expect(xml).not.toMatch(/<testsuites [^>]*>\n\s*<properties>/);
  });

  it("does not fail an OAuth suite whose only non-passing flow is not-applicable", () => {
    const suite = createOAuthSuiteResult();
    suite.passed = true;
    suite.results = [
      { ...createOAuthResult({ passed: true, outcome: "passed", steps: [] }), label: "dcr" },
      {
        ...createOAuthResult({ passed: false, outcome: "not-applicable", steps: [] }),
        label: "no-auth",
      },
    ];

    const report = toConformanceReport(suite);
    // A no-auth flow is not a pass, but authorization is OPTIONAL — it must
    // not drag the suite verdict to failed.
    expect(report.outcome).toBe("passed");
  });

  it("reports not-scored for an OAuth run against a server without auth", () => {
    const report = toConformanceReport(
      createOAuthResult({ passed: true, outcome: "not-applicable" }),
    );
    expect(report.score?.score).toBeNull();

    const xml = renderConformanceReportJUnitXml(report);
    expect(xml).toContain(
      '<property name="mcpjam.conformance.score" value="not-scored"/>',
    );
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

  /**
   * The exit code already refuses to fail on a pending check. If the JUnit
   * renderer still emitted `<failure>` for one, the CI job would go red anyway
   * — reopening the retroactive-failure hole the frozen profile exists to
   * close, on the one channel most teams actually gate on.
   */
  it("renders a FAILING pending check as skipped, and excludes it from the failure tallies", () => {
    const result: MCPConformanceResult = {
      ...createProtocolResult(),
      checks: [
        {
          id: "wire-schema-valid",
          category: "protocol",
          title: "Wire Schema Valid",
          description: "Every observed message validates against the schema.",
          status: "failed",
          durationMs: 3,
          error: { message: "ListToolsResult: must have required property 'ttlMs'" },
        },
      ],
      profile: {
        profileId: "mcp-protocol",
        profileVersion: "2026-08-21.1",
        manifestDigest: "0".repeat(64),
        checkerVersion: "0.0.0-test",
        pendingCheckIds: ["wire-schema-valid"],
      },
    };

    const xml = renderConformanceReportJUnitXml(toConformanceReport(result));

    expect(xml).not.toContain("<failure");
    expect(xml).toContain("unscored by the active profile");
    expect(xml).toContain('failures="0"');
  });

  /**
   * The same hole, on the TASKS suite. Tasks cases go through
   * `reportCaseFromCheck`, which never read `pendingCheckIds` — so the fix
   * above closed the protocol path and left this one open, and a failing
   * pending Tasks check still turned the CI job red against a green exit code.
   */
  it("renders a FAILING pending TASKS check as skipped too", () => {
    const result: MCPTasksConformanceResult = {
      passed: false,
      outcome: "failed",
      target: "https://mcp.example.com/mcp",
      durationMs: 12,
      summary: "1 failed",
      checks: [
        {
          id: "tasks-status-payload-shape",
          category: "lifecycle",
          title: "Task status payloads carry their required members",
          description: "Each observed status carries what the extension states.",
          status: "failed",
          durationMs: 3,
          error: { message: "completed: must carry the `result` field" },
        },
      ],
      categorySummary: {},
      discovery: { wire: "extension", toolCount: 1, taskCapableToolCount: 1 },
      profile: {
        profileId: "mcp-tasks",
        profileVersion: "2026-08-22.1",
        manifestDigest: "0".repeat(64),
        checkerVersion: "0.0.0-test",
        pendingCheckIds: ["tasks-status-payload-shape"],
      },
    } as unknown as MCPTasksConformanceResult;

    const xml = renderConformanceReportJUnitXml(toConformanceReport(result));

    expect(xml).not.toContain("<failure");
    expect(xml).toContain('failures="0"');
  });
});
