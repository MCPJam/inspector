import {
  buildEvalRunReport,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  summarizeStructuredCases,
  type StructuredRunReport,
} from "../src/structured-reporting";
import { parseJUnitXmlArtifact } from "../src/artifact-parsers";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "../src/platform/types";

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

  it("carries an optional decision summary through telemetry redaction", () => {
    const decisionSummary = {
      verdict: "failed" as const,
      passRate: { total: 1, passed: 0, failed: 1, percent: 0 },
      iterationWalkComplete: true,
      cases: [],
    };
    const report: StructuredRunReport = {
      schemaVersion: 1,
      kind: "eval",
      passed: false,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
      decisionSummary,
    };
    expect(renderStructuredRunJson(report)).toEqual(report);
  });

  it("keeps reports without a decision summary unchanged", () => {
    const report: StructuredRunReport = {
      schemaVersion: 1,
      kind: "eval",
      passed: true,
      summary: summarizeStructuredCases([]),
      cases: [],
      durationMs: 0,
      metadata: {},
    };
    expect(renderStructuredRunJson(report)).toEqual(report);
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

describe("buildEvalRunReport", () => {
  it("folds iterations into one testcase per case and preserves failure messages", () => {
    const run = {
      id: "run-1",
      suiteId: "suite-1",
      runNumber: 1,
      status: "completed",
      result: "failed",
      summary: { total: 3, passed: 2, failed: 1, passRate: 2 / 3 },
      source: "api",
      notes: null,
      createdAt: 100,
      completedAt: 300,
    } satisfies PlatformEvalRun;
    const iteration = (
      id: string,
      testCaseId: string,
      title: string,
      iterationNumber: number,
      result: "passed" | "failed",
      error: string | null
    ) =>
      ({
        id,
        testCaseId,
        title,
        iterationNumber,
        status: "completed",
        result,
        model: null,
        provider: null,
        startedAt: null,
        durationMs: 10,
        tokensUsed: null,
        usage: null,
        actualToolCalls: [],
        expectedToolCalls: [],
        error,
      } satisfies PlatformEvalIteration);
    const report = buildEvalRunReport([
      {
        run,
        iterationsComplete: true,
        iterations: [
          iteration("i-1", "case-a", "Case A", 1, "passed", null),
          iteration("i-2", "case-a", "Case A", 2, "failed", "goal missed"),
          iteration("i-3", "case-b", "Case B", 1, "passed", null),
        ],
      },
    ]);

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "eval-run",
      passed: false,
      summary: { total: 2, passed: 1, failed: 1 },
      durationMs: 200,
    });
    expect(report.cases).toHaveLength(2);
    expect(report.cases[0]).toMatchObject({
      id: "run-1:case-a",
      title: "Case A",
      passed: false,
      error: "goal missed",
      durationMs: 20,
    });

    const parsed = parseJUnitXmlArtifact(renderStructuredRunJUnitXml(report));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].passed).toBe(false);
    expect(parsed[0].error).toContain("goal missed");
    expect(parsed[1].passed).toBe(true);
  });

  it("adds a failing reporting testcase when iteration pagination is incomplete", () => {
    const report = buildEvalRunReport([
      {
        run: {
          id: "run-1",
          suiteId: "suite-1",
          runNumber: 1,
          status: "completed",
          result: "passed",
          summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 100,
          completedAt: 300,
        },
        iterations: [],
        iterationsComplete: false,
        iterationError: "page 2 failed",
      },
    ]);

    expect(report.passed).toBe(false);
    expect(report.cases).toEqual([
      expect.objectContaining({
        id: "run-1:iterations",
        passed: false,
        error: "page 2 failed",
      }),
    ]);
  });
});
