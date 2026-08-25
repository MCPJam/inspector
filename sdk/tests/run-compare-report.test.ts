/**
 * `buildRunCompareReport` — the adapter that gives `mcpjam cloud eval compare` its
 * JSON and JUnit output.
 *
 * The two decisions worth pinning are both about what "failed" means:
 *   - `passed` comes from the GATE, not from the case rows. A regression the
 *     policy never asked about must not fail a build, and a non-gateable
 *     policy must not pass one.
 *   - only `regressed` rows fail. A suite edit (`new_case`, `removed_case`,
 *     `changed`) is a diff in the tests, not in the product; failing on it is
 *     how teams learn to pass `--no-verify`.
 */
import { describe, expect, it } from "vitest";
import { buildRunCompareReport } from "../src/run-compare.js";
import { renderStructuredRunJUnitXml } from "../src/structured-reporting.js";
import type { GateReport } from "../src/gates.js";
import type {
  PlatformNumericDiff,
  PlatformRunCompare,
  PlatformRunCompareCase,
} from "../src/platform/types.js";

const ZERO: PlatformNumericDiff = {
  base: null,
  compare: null,
  delta: null,
  percentDelta: null,
};

function caseRow(
  overrides: Partial<PlatformRunCompareCase> = {}
): PlatformRunCompareCase {
  return {
    caseKey: "ck_a",
    title: "Case A",
    status: "unchanged_passed",
    configChanged: false,
    evaluationConfigChanged: false,
    scoreDeltas: [],
    base: {
      outcome: "passed",
      iterationIds: ["i1"],
      representativeIterationId: "i1",
      error: null,
    },
    compare: {
      outcome: "passed",
      iterationIds: ["i2"],
      representativeIterationId: "i2",
      error: null,
    },
    ...overrides,
  };
}

function compareWire(cases: PlatformRunCompareCase[]): PlatformRunCompare {
  return {
    suite: { id: "suite_1", name: "Checkout" },
    baseline: { policy: "previous_completed", baseRunId: "run_1" },
    baseRun: {
      id: "run_1",
      runNumber: 1,
      result: "passed",
      createdAt: 1000,
      completedAt: 2000,
      summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
    },
    compareRun: {
      id: "run_2",
      runNumber: 2,
      result: "failed",
      createdAt: 3000,
      completedAt: 5000,
      summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
    },
    passSummary: {
      passRatePercent: { base: 100, compare: 50, delta: -50, percentDelta: -50 },
      total: ZERO,
      passed: ZERO,
      failed: ZERO,
    },
    metrics: {
      wallDurationMs: ZERO,
      totalTokens: ZERO,
      estimatedCostUsd: ZERO,
    },
    scoreContract: {
      base: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: 2,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg",
        scoreIntegrity: "valid",
        scoredIterations: 2,
        quarantinedIterations: 0,
      },
      evaluationConfigChanged: false,
      scorers: [],
    },
    cases,
  };
}

const FAILED_GATE: GateReport = {
  outcome: "failed",
  scoreIntegrity: "valid",
  verdicts: [
    {
      gate: "noDeterministicRegressions",
      status: "failed",
      message: "1 deterministic gating regression(s): ck_b/tool-match",
      observed: 1,
    },
  ],
};

const PASSED_GATE: GateReport = {
  outcome: "passed",
  scoreIntegrity: "valid",
  verdicts: [],
};

const INCOMPLETE_GATE: GateReport = {
  outcome: "incomplete",
  scoreIntegrity: "unknown",
  verdicts: [
    {
      gate: "baseline",
      status: "non_gateable",
      message: "no baseline to compare against",
    },
  ],
};

describe("buildRunCompareReport", () => {
  it("takes `passed` from the gate, not from the case rows", () => {
    const wire = compareWire([caseRow({ status: "regressed" })]);
    // A regression is present, but no policy asked about it.
    expect(buildRunCompareReport(wire, PASSED_GATE).passed).toBe(true);
    // And a clean set of rows still fails when the gate says so.
    expect(
      buildRunCompareReport(compareWire([caseRow()]), FAILED_GATE).passed
    ).toBe(false);
  });

  it("carries the gate's verdict — incomplete as inconclusive, never failed", () => {
    // A non-gateable comparison (no baseline yet) is unmeasured, not a
    // regression: a reporter that infers the verdict from `passed` alone
    // would paint it the same red as an actual failure.
    expect(
      buildRunCompareReport(compareWire([caseRow()]), INCOMPLETE_GATE).verdict
    ).toBe("inconclusive");
    expect(
      buildRunCompareReport(compareWire([caseRow()]), PASSED_GATE).verdict
    ).toBe("passed");
    expect(
      buildRunCompareReport(compareWire([caseRow()]), FAILED_GATE).verdict
    ).toBe("failed");
  });

  it("fails only `regressed` rows; suite edits are informational", () => {
    const report = buildRunCompareReport(
      compareWire([
        caseRow({ caseKey: "ck_regressed", status: "regressed" }),
        caseRow({ caseKey: "ck_new", status: "new_case" }),
        caseRow({ caseKey: "ck_removed", status: "removed_case" }),
        caseRow({ caseKey: "ck_changed", status: "changed" }),
        caseRow({ caseKey: "ck_fixed", status: "fixed" }),
        caseRow({ caseKey: "ck_stable" }),
      ]),
      PASSED_GATE
    );

    expect(
      report.cases.filter((row) => !row.passed).map((row) => row.id)
    ).toEqual(["ck_regressed"]);
    // 6 comparison rows + the synthetic gate row.
    expect(report.summary.total).toBe(7);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.byClassification).toMatchObject({
      breaking: { total: 1, passed: 0, failed: 1 },
    });
  });

  it("names the gating scorers behind a regression, skipping changed definitions", () => {
    const report = buildRunCompareReport(
      compareWire([
        caseRow({
          status: "regressed",
          compare: {
            outcome: "failed",
            iterationIds: ["i2"],
            representativeIterationId: "i2",
            error: "tool never called",
          },
          scoreDeltas: [
            {
              scorerId: "tool-match",
              gating: true,
              deterministic: true,
              definitionChanged: false,
              base: { status: "scored", value: 1, passed: true },
              compare: { status: "scored", value: 0, passed: false },
              value: ZERO,
            },
            {
              // Same flip, but the definition changed — the two sides did not
              // measure the same thing, so it must NOT be named as a cause.
              scorerId: "rewritten",
              gating: true,
              deterministic: true,
              definitionChanged: true,
              base: { status: "scored", value: 1, passed: true },
              compare: { status: "scored", value: 0, passed: false },
              value: ZERO,
            },
          ],
        }),
      ]),
      FAILED_GATE
    );

    const error = report.cases[0].error ?? "";
    expect(error).toContain("passed -> failed");
    expect(error).toContain("tool-match");
    expect(error).not.toContain("rewritten");
    expect(error).toContain("tool never called");
  });

  it("carries the baseline, gate and score contract in metadata", () => {
    const report = buildRunCompareReport(
      compareWire([caseRow()]),
      FAILED_GATE,
      { flakyCases: [{ caseKey: "ck_wobbly", total: 3, passed: 2, failed: 1 }] }
    );

    expect(report.kind).toBe("run-compare");
    expect(report.metadata.baseline).toEqual({
      policy: "previous_completed",
      baseRunId: "run_1",
    });
    expect(report.metadata.gate).toMatchObject({
      outcome: "failed",
      scoreIntegrity: "valid",
    });
    // Flakiness rides in the report but never touched the gate.
    expect(report.metadata.flakyCases).toEqual([
      { caseKey: "ck_wobbly", total: 3, passed: 2, failed: 1 },
    ]);
    expect(report.metadata.scoreContract).toBeDefined();
    // The wire's `passSummary` name survives into the report: "scores" must
    // never mean run counters on this path.
    expect(report.metadata.passSummary).toBeDefined();
    expect(report.metadata).not.toHaveProperty("scores");
  });

  it("renders JUnit XML exactly", () => {
    const report = buildRunCompareReport(
      compareWire([
        caseRow({ caseKey: "ck_stable", title: "Stable" }),
        caseRow({
          caseKey: "ck_regressed",
          title: "Regressed",
          status: "regressed",
          base: {
            outcome: "passed",
            iterationIds: ["i1"],
            representativeIterationId: "i1",
            error: null,
          },
          compare: {
            outcome: "failed",
            iterationIds: ["i2"],
            representativeIterationId: "i2",
            error: null,
          },
        }),
      ]),
      FAILED_GATE,
      { durationMs: 1500 }
    );

    // A LITERAL, not a snapshot: this XML is consumed by CI systems, and an
    // auto-updating snapshot would let a rendering change land unnoticed.
    expect(renderStructuredRunJUnitXml(report)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="run-compare" tests="3" failures="2" time="1.500">
  <testsuite name="run-compare" tests="3" failures="2" time="1.500">
    <testcase name="Stable" classname="mcpjam.run-compare.unchanged_passed" time="0.000"/>
    <testcase name="Regressed" classname="mcpjam.run-compare.regressed" time="0.000">
      <failure message="passed -&gt; failed">{&quot;status&quot;:&quot;regressed&quot;,&quot;configChanged&quot;:false,&quot;evaluationConfigChanged&quot;:false,&quot;base&quot;:&quot;passed&quot;,&quot;compare&quot;:&quot;failed&quot;}</failure>
    </testcase>
    <testcase name="gate: failed" classname="mcpjam.run-compare.gate" time="0.000">
      <failure message="Gate: FAILED (score integrity: valid)
  FAIL noDeterministicRegressions: 1 deterministic gating regression(s): ck_b/tool-match">{&quot;outcome&quot;:&quot;failed&quot;,&quot;scoreIntegrity&quot;:&quot;valid&quot;,&quot;verdicts&quot;:[{&quot;gate&quot;:&quot;noDeterministicRegressions&quot;,&quot;status&quot;:&quot;failed&quot;,&quot;message&quot;:&quot;1 deterministic gating regression(s): ck_b/tool-match&quot;,&quot;observed&quot;:1}]}</failure>
    </testcase>
  </testsuite>
</testsuites>
`
    );
  });

  it("always emits a gate row, so JUnit and the exit code cannot disagree", () => {
    // Failing gate, zero regressed rows: without the gate row this renders
    // ZERO JUnit failures while the command exits 1.
    const failing = buildRunCompareReport(
      compareWire([caseRow()]),
      FAILED_GATE
    );
    const gateRow = failing.cases.find((row) => row.id === "gate");
    expect(gateRow?.passed).toBe(false);
    expect(gateRow?.error).toContain("Gate: FAILED");
    expect(renderStructuredRunJUnitXml(failing)).toContain("<failure");

    // Passing gate: the row is present and green, so the count is honest in
    // the other direction too.
    const passing = buildRunCompareReport(
      compareWire([caseRow({ status: "regressed" })]),
      PASSED_GATE
    );
    expect(passing.cases.find((row) => row.id === "gate")?.passed).toBe(true);
  });

  it("renders a synthetic case rather than an empty suite", () => {
    const xml = renderStructuredRunJUnitXml(
      buildRunCompareReport(compareWire([]), PASSED_GATE)
    );
    // Never an empty <testsuite>, which every CI UI reads as "nothing ran":
    // the gate row alone is enough.
    expect(xml).toContain('tests="1"');
    expect(xml).toContain("gate: passed");
  });

  it("carries a supplied decision summary and omits it when absent", () => {
    const decisionSummary = {
      verdict: "failed" as const,
      passRate: { total: 1, passed: 0, failed: 1, percent: 0 },
      iterationWalkComplete: true,
      cases: [],
    };
    expect(
      buildRunCompareReport(compareWire([]), PASSED_GATE, {
        decisionSummary,
      }).decisionSummary
    ).toBe(decisionSummary);
    expect(
      buildRunCompareReport(compareWire([]), PASSED_GATE)
    ).not.toHaveProperty("decisionSummary");
  });
});
