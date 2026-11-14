import type { ConformanceReport } from "../src/conformance-reporting.js";
import { renderConformanceReportJUnitXml } from "../src/conformance-reporting.js";
import { renderConformanceRunJUnitXml } from "../src/conformance-run-junit.js";
import type { ConformanceRunReportV1 } from "../src/conformance-run-types.js";

function suiteReport(
  kind: ConformanceReport["kind"],
  name: string,
  cases: ConformanceReport["groups"][number]["cases"]
): ConformanceReport {
  return {
    schemaVersion: 1,
    kind,
    name,
    passed: false,
    durationMs: 40,
    groups: [
      {
        id: kind,
        title: name,
        target: "https://mcp.example.com/mcp",
        passed: false,
        durationMs: 40,
        cases,
      },
    ],
  };
}

const protocol = suiteReport(
  "protocol-conformance",
  "MCP Protocol Conformance",
  [
    {
      id: "ping",
      title: "Ping",
      category: "core",
      status: "passed",
      durationMs: 3,
    },
    {
      id: "wire-schema-valid",
      title: "Wire Schema Valid",
      category: "protocol",
      status: "failed",
      durationMs: 5,
      error: "1 observed message does not match the schema",
    },
  ]
);

const apps = suiteReport("apps-conformance", "MCP Apps Conformance", [
  {
    id: "ui-resources",
    title: "UI Resources",
    category: "resources",
    status: "skipped",
    skipReason: "not-applicable",
    durationMs: 0,
  },
]);

function run(
  reports: ConformanceRunReportV1["reports"],
  requestedSuites: ConformanceRunReportV1["requestedSuites"]
): ConformanceRunReportV1 {
  return {
    schemaVersion: 1,
    requestedSuites,
    reports,
    outcome: "failed",
    score: {
      score: 50,
      outcome: "failed",
      applicable: 2,
      passed: 1,
      failed: 1,
      couldNotRun: 0,
    },
    durationMs: 1250,
  } as ConformanceRunReportV1;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("renderConformanceRunJUnitXml", () => {
  it("puts every suite under one <testsuites> root with one prolog", () => {
    const xml = renderConformanceRunJUnitXml(
      run({ apps, protocol }, ["protocol", "apps"])
    );

    expect(count(xml, "<?xml")).toBe(1);
    expect(count(xml, "<testsuites ")).toBe(1);
    expect(count(xml, "</testsuites>")).toBe(1);
    expect(xml.trimEnd().endsWith("</testsuites>")).toBe(true);
    expect(xml).toContain(
      '<testsuites name="MCPJam Conformance" tests="3" failures="1" skipped="1" time="1.250">'
    );
  });

  it("orders suites protocol, apps, tasks, oauth whatever order they finished in", () => {
    const xml = renderConformanceRunJUnitXml(
      run({ apps, protocol }, ["protocol", "apps"])
    );

    expect(
      xml.indexOf('testsuite name="MCP Protocol Conformance"')
    ).toBeLessThan(xml.indexOf('testsuite name="MCP Apps Conformance"'));
  });

  it("gives a requested suite that never reported a skipped testsuite", () => {
    const xml = renderConformanceRunJUnitXml(
      run({ protocol }, ["protocol", "tasks"])
    );

    expect(xml).toContain(
      '<testsuite name="tasks" tests="1" failures="0" skipped="1"'
    );
    expect(xml).toContain(
      "The tasks suite did not report results, so the run is incomplete."
    );
    expect(xml).toContain('tests="3" failures="1" skipped="1"');
  });

  it("keeps each suite's testsuites identical to its own JUnit document", () => {
    const single = renderConformanceReportJUnitXml(protocol);
    const body = single.slice(
      single.indexOf("\n  <testsuite"),
      single.lastIndexOf("\n</testsuites>")
    );
    const combined = renderConformanceRunJUnitXml(
      run({ protocol }, ["protocol"])
    );

    expect(combined).toContain(body);
  });
});
