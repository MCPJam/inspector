import { describe, expect, it } from "vitest";
import {
  buildEvalDecisionSummary,
  buildEvalDecisionSummaryFromIterations,
  formatEvalDecisionSummary,
} from "../src/eval-decision-summary.js";
import { STAGE_ANALYZER_VERSION } from "../src/contract/index.js";
import type { NormalizedEvalDecisionCase } from "../src/eval-decision-summary.js";

const stages = [
  {
    stage: "connection",
    state: "passed",
    reason: "observed",
    evidence: { spanIds: ["span-connect"] },
  },
  {
    stage: "discovery",
    state: "passed",
    reason: "observed",
    evidence: { spanIds: ["span-discover"] },
  },
  {
    stage: "selection",
    state: "passed",
    reason: "observed",
    evidence: { promptIndexes: [0] },
  },
  {
    stage: "call",
    state: "failed",
    reason: "argumentMismatch",
    evidence: { spanIds: ["span-call"], predicateReasons: ["wrong argument"] },
  },
  {
    stage: "response",
    state: "notReached",
    reason: "earlierStageFailed",
  },
  {
    stage: "userValue",
    state: "notReached",
    reason: "earlierStageFailed",
  },
] as const;

function inputCase(
  overrides: Partial<NormalizedEvalDecisionCase> = {}
): NormalizedEvalDecisionCase {
  return {
    id: "iteration-1",
    title: "Fetch order",
    iterationNumber: 1,
    result: "failed",
    expectedToolCalls: [{ toolName: "fetch_order" }],
    actualToolCalls: [{ toolName: "fetch_order" }],
    error: "server rejected arguments",
    stageResults: stages,
    firstFailedStage: "call",
    failureCategory: "arguments",
    stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
    ...overrides,
  };
}

function render(inputCaseOverrides: Partial<NormalizedEvalDecisionCase> = {}) {
  return formatEvalDecisionSummary(
    buildEvalDecisionSummary({
      total: 1,
      passed: 0,
      failed: 1,
      iterationWalkComplete: true,
      cases: [inputCase(inputCaseOverrides)],
    })
  );
}

describe("eval decision summary", () => {
  it("renders a verified failed chain and bounded evidence", () => {
    const text = render();
    expect(text).toContain("Decision summary: failed — 0/1 cases passed (0%)");
    expect(text).toContain("first failed stage call");
    expect(text).toContain("failure category arguments");
    expect(text).toContain("expected tool calls: fetch_order");
    expect(text).toContain("observed failure: server rejected arguments");
    expect(text).toContain("span ids span-connect, span-discover, span-call");
    expect(text).toContain("prompt indexes 0");
    expect(text).toContain("reasons wrong argument");
    expect(text).not.toContain("root cause");

    const evidenceSummary = buildEvalDecisionSummary({
      total: 1,
      passed: 0,
      failed: 1,
      iterationWalkComplete: true,
      cases: [
        inputCase({
          stageResults: stages.map((row, index) => ({
            ...row,
            evidence: { spanIds: [`span-${index}`] },
          })),
        }),
      ],
    });
    expect(evidenceSummary.cases[0]?.evidence?.spanIds).toEqual([
      "span-0",
      "span-1",
      "span-2",
      "span-3",
      "span-4",
      "span-5",
    ]);
  });

  it("keeps setup abort honest and preserves all non-verdict states", () => {
    const text = render({
      firstFailedStage: undefined,
      failureCategory: "setup",
      stageResults: [
        { stage: "connection", state: "notMeasured", reason: "setupAborted" },
        { stage: "discovery", state: "notMeasured", reason: "setupAborted" },
        { stage: "selection", state: "notMeasured", reason: "setupAborted" },
        { stage: "call", state: "notMeasured", reason: "setupAborted" },
        { stage: "response", state: "notMeasured", reason: "setupAborted" },
        { stage: "userValue", state: "notMeasured", reason: "setupAborted" },
      ],
    });
    expect(text).toContain("no first failed stage — did not reach the server's stages");
    expect(text).toContain("failure category setup");
    expect(text).not.toContain("first failed stage connection");

    const summary = buildEvalDecisionSummary({
      total: 1,
      passed: 0,
      failed: 1,
      iterationWalkComplete: true,
      cases: [
        inputCase({
          stageResults: [
            { stage: "connection", state: "notMeasured" },
            { stage: "discovery", state: "notApplicable" },
            { stage: "selection", state: "notReached" },
            { stage: "call", state: "notMeasured" },
            { stage: "response", state: "notApplicable" },
            { stage: "userValue", state: "notReached" },
          ],
          firstFailedStage: undefined,
          failureCategory: "setup",
        }),
      ],
    });
    expect(summary.cases[0]?.stageChain?.map((row) => row.state)).toEqual([
      "notMeasured",
      "notApplicable",
      "notReached",
      "notMeasured",
      "notApplicable",
      "notReached",
    ]);
  });

  it("omits a quarantined chain and reports pre-D1 metadata distinctly", () => {
    const unverified = render({
      stageResults: [{ stage: "connection", state: "failed" }],
      stageResultsUnverified: true,
    });
    expect(unverified).toContain("stage chain unverified — chain omitted");
    expect(unverified).toContain(
      "first failed stage not established because the stage chain was unverified"
    );
    expect(unverified).not.toContain("did not reach the server's stages");

    const preD1 = formatEvalDecisionSummary(
      buildEvalDecisionSummary({
        total: 1,
        passed: 0,
        failed: 1,
        iterationWalkComplete: true,
        cases: [
          inputCase({
            stageResults: undefined,
            firstFailedStage: undefined,
            failureCategory: undefined,
            stageAnalyzerVersion: undefined,
          }),
        ],
      })
    );
    expect(preD1).toContain(
      "no stage metadata was recorded for this run, so no first failed stage is known"
    );
    expect(preD1).not.toContain("did not reach the server's stages");
    expect(preD1).toContain("no stage metadata was recorded for this run");
    expect(preD1).toContain(
      "next action: inspect the case trace; no failure category was recorded"
    );
  });

  it("omits a redundant id parenthetical when the iteration has no title", () => {
    const summary = buildEvalDecisionSummaryFromIterations(
      [
        {
          id: "iteration-1",
          title: null,
          iterationNumber: 1,
          result: "failed",
          expectedToolCalls: [],
          actualToolCalls: [],
          stageResults: undefined,
        },
      ],
      { iterationWalkComplete: true }
    );
    const text = formatEvalDecisionSummary(summary);
    expect(text).toContain("  iteration-1 (iteration 1)");
    expect(text).not.toContain("iteration-1 (iteration-1, iteration 1)");
  });

  it("flags a version-ahead chain without filtering the reported derivation", () => {
    const summary = buildEvalDecisionSummary({
      total: 1,
      passed: 0,
      failed: 1,
      iterationWalkComplete: true,
      cases: [
        inputCase({
          stageAnalyzerVersion: STAGE_ANALYZER_VERSION + 1,
        }),
      ],
    });
    expect(summary.cases[0]?.stageChainStatus).toBe("verified");
    expect(summary.cases[0]?.stageAnalyzerVersionAhead).toEqual({
      reported: STAGE_ANALYZER_VERSION + 1,
      known: STAGE_ANALYZER_VERSION,
    });
    expect(formatEvalDecisionSummary(summary)).toContain(
      `stage chain reported by a newer analyzer (version ${
        STAGE_ANALYZER_VERSION + 1
      }, this build knows ${STAGE_ANALYZER_VERSION})`
    );
  });

  it("uses incomplete for no cases and labels partial walks", () => {
    const empty = buildEvalDecisionSummary({
      total: 0,
      passed: 0,
      failed: 0,
      iterationWalkComplete: true,
      cases: [],
    });
    expect(empty.verdict).toBe("incomplete");
    expect(empty.passRate.percent).toBeNull();
    expect(formatEvalDecisionSummary(empty)).toContain("(no cases)");

    const partial = buildEvalDecisionSummary({
      total: 2,
      passed: 1,
      failed: 1,
      iterationWalkComplete: false,
      cases: [inputCase()],
    });
    expect(partial.verdict).toBe("incomplete");
    expect(formatEvalDecisionSummary(partial)).toContain(
      "(partial iteration walk)"
    );
  });
});
