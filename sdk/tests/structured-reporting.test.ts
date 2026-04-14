import {
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  summarizeStructuredCases,
  type StructuredRunReport,
} from "../src/structured-reporting";

describe("summarizeStructuredCases", () => {
  it("computes totals, category rollups, and classification rollups", () => {
    const summary = summarizeStructuredCases([
      {
        id: "tool:echo",
        title: "echo",
        category: "tools",
        passed: true,
        classification: "non_breaking",
      },
      {
        id: "schema:echo:input",
        title: "echo:input",
        category: "schemas",
        passed: false,
        classification: "breaking",
      },
    ]);

    expect(summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      byCategory: {
        tools: { total: 1, passed: 1, failed: 0 },
        schemas: { total: 1, passed: 0, failed: 1 },
      },
      byClassification: {
        non_breaking: { total: 1, passed: 1, failed: 0 },
        breaking: { total: 1, passed: 0, failed: 1 },
      },
    });
  });
});

describe("renderStructuredRunJson", () => {
  it("redacts sensitive metadata before serialization", () => {
    const report: StructuredRunReport = {
      schemaVersion: 1,
      kind: "tools-call-validation",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 5,
      metadata: {
        headers: { Authorization: "Bearer super-secret" },
        refreshToken: "refresh-secret",
      },
    };

    expect(renderStructuredRunJson(report)).toEqual({
      ...report,
      metadata: {
        headers: { Authorization: "[REDACTED]" },
        refreshToken: "[REDACTED]",
      },
    });
  });
});

describe("renderStructuredRunJUnitXml", () => {
  it("emits the fixed synthetic pass for empty server diffs", () => {
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "server-diff",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    });

    expect(xml).toContain('classname="mcpjam.server-diff"');
    expect(xml).toContain('name="no-drift"');
  });

  it("emits the fixed synthetic pass for empty tool validation reports", () => {
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "tools-call-validation",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    });

    expect(xml).toContain('classname="mcpjam.tools-call-validation"');
    expect(xml).toContain('name="validation-passed"');
  });

  it("emits a synthetic failure when an empty run failed overall", () => {
    const xml = renderStructuredRunJUnitXml({
      schemaVersion: 1,
      kind: "server-diff",
      passed: false,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    });

    expect(xml).toContain('failures="1"');
    expect(xml).toContain('name="failed"');
    expect(xml).toContain("Run failed without individual cases.");
  });
});
