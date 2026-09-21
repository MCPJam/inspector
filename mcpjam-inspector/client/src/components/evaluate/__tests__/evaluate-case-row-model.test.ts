/**
 * The case-row join, and the four ways it is allowed to fail.
 *
 * A mark on this row is a VERDICT — the case's own, decided against its own
 * threshold. Every path that cannot establish one has to say so rather than
 * fall back to the iteration count and let it be read as a decision. Those
 * paths are most of this file.
 */
import { describe, expect, it } from "vitest";
import {
  evalCaseAggregationKey,
  type EvalRunDecisionChain,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import {
  buildEvaluateCaseRows,
  caseRowReasonLabel,
  defaultOpenCaseRow,
  type BuildCaseRowsInput,
} from "../evaluate-case-row-model";
import {
  executionVariantOf,
  mintCaseIdCandidates,
} from "../evaluate-case-identity";
import type { RunCaseGroup } from "../../evals/run-case-groups";
import type { EvalIteration } from "../../evals/types";

function iteration(
  id: string,
  result: string,
  snapshot: Record<string, unknown> = {},
  testCaseId = "tc_1",
): EvalIteration {
  return {
    _id: id,
    status: "completed",
    result,
    testCaseId,
    testCaseSnapshot: { caseKey: "hash:abc", ...snapshot },
  } as unknown as EvalIteration;
}

function group(
  overrides: Partial<RunCaseGroup> & { key: string },
): RunCaseGroup {
  const iterations = overrides.iterations ?? [iteration("it_1", "failed")];
  return {
    testCaseId: "tc_1",
    title: "Draw and share a diagram",
    model: "claude",
    passed: iterations.filter((row) => row.result === "passed").length,
    failed: iterations.filter((row) => row.result === "failed").length,
    pending: 0,
    cancelled: 0,
    total: iterations.length,
    p50Ms: 1000,
    p95Ms: 2000,
    iterationResults: [],
    ...overrides,
    iterations,
  } as RunCaseGroup;
}

const VERIFIED_CHAIN: EvalRunDecisionChain = {
  status: "verified",
  stages: [
    { stage: "connection", state: "passed" },
    { stage: "discovery", state: "passed" },
    { stage: "selection", state: "failed", reason: "missingToolCall" },
    { stage: "call", state: "notReached" },
    { stage: "response", state: "notReached" },
    { stage: "userValue", state: "notMeasured" },
  ],
  firstFailedStage: "selection",
  analyzerVersion: 8,
};

function diagnostic(iterationId: string): EvalRunDecisionDiagnostic {
  return {
    iterationId,
    iterationNumber: 1,
    testCaseId: "tc_1",
    title: "Draw and share a diagram",
    status: "completed",
    result: "failed",
    chain: VERIFIED_CHAIN,
    evidence: { runId: "r", iterationId, tracePath: "/t" },
    nextAction: "review tool selection and the tool catalog",
  } as EvalRunDecisionDiagnostic;
}

function summaryWithCases(
  cases: Array<Record<string, unknown>>,
): EvalRunDecisionSummary {
  return {
    schemaVersion: 1,
    runId: "run_1",
    runStatus: "completed",
    verdict: "failed",
    verdictSource: "policyV2",
    decision: { cases },
    diagnostics: { items: [], complete: true, scannedIterations: 1 },
  } as unknown as EvalRunDecisionSummary;
}

function input(
  overrides: Partial<BuildCaseRowsInput> = {},
): BuildCaseRowsInput {
  return {
    groups: [group({ key: "g1" })],
    summary: null,
    diagnostics: [],
    chains: new Map(),
    chainsLoaded: true,
    decisionStatus: "ready",
    ...overrides,
  };
}

describe("minting a case identity", () => {
  it("encodes the readable families the backend encodes", () => {
    expect(
      mintCaseIdCandidates({
        testCaseId: "tc_1",
        testCaseSnapshot: { caseKey: "hash:abc" },
      } as EvalIteration),
    ).toEqual(["k_hash_abc", "c_tc_1"]);

    expect(
      mintCaseIdCandidates({
        testCaseId: "tc_1",
        testCaseSnapshot: { caseKey: "external:x1" },
      } as EvalIteration),
    ).toEqual(["k_ext_x1", "c_tc_1"]);
  });

  it("falls back to the row id when there is no case key", () => {
    expect(
      mintCaseIdCandidates({
        testCaseId: "tc_9",
        testCaseSnapshot: {},
      } as EvalIteration),
    ).toEqual(["c_tc_9"]);
  });

  it("declines to mint what the backend would have hashed", () => {
    // The backend hashes an identity that fails its id pattern. sha256 is not
    // available synchronously here, so minting anything would produce a key
    // that can never match — better to report that than to guess.
    expect(
      mintCaseIdCandidates({
        testCaseId: "tc/../weird",
        testCaseSnapshot: { caseKey: "some:other:space" },
      } as EvalIteration),
    ).toEqual([]);
  });

  it("reads a variant only from a snapshot that names a model", () => {
    expect(
      executionVariantOf({
        testCaseSnapshot: { model: "gpt-5" },
      } as EvalIteration),
    ).toEqual({ model: "gpt-5" });
    expect(
      executionVariantOf({ testCaseSnapshot: {} } as EvalIteration),
    ).toBeUndefined();
  });
});

describe("joining a verdict onto a row", () => {
  it("takes the case's own verdict when the key matches", () => {
    const rows = buildEvaluateCaseRows(
      input({
        summary: summaryWithCases([
          {
            caseId: "k_hash_abc",
            verdict: "failed",
            passedTrials: 6,
            failedTrials: 4,
            configuredTrials: 10,
            effectivePassThreshold: 0.7,
          },
        ]),
      }),
    );
    expect(rows[0].mark).toBe("failed");
    expect(rows[0].verdict).toMatchObject({ kind: "matched" });
  });

  it("keys by variant only for cases the decision fanned out", () => {
    // The backend's rule. Reading the iteration's model for a case the
    // decision did not fan out builds a key no row can equal.
    const rows = buildEvaluateCaseRows(
      input({
        groups: [
          group({
            key: "g1",
            iterations: [
              iteration("it_1", "failed", {
                caseKey: "hash:abc",
                model: "claude",
              }),
            ],
          }),
        ],
        summary: summaryWithCases([
          {
            caseId: "k_hash_abc",
            executionVariant: { model: "claude" },
            verdict: "failed",
            passedTrials: 0,
            failedTrials: 1,
            configuredTrials: 1,
          },
        ]),
      }),
    );
    expect(rows[0].mark).toBe("failed");
    expect(evalCaseAggregationKey({ caseId: "k_hash_abc" })).not.toBe(
      evalCaseAggregationKey({
        caseId: "k_hash_abc",
        executionVariant: { model: "claude" },
      }),
    );
  });

  it("says no row matched rather than assuming an outcome", () => {
    const rows = buildEvaluateCaseRows(
      input({
        summary: summaryWithCases([
          {
            caseId: "k_hash_other",
            verdict: "passed",
            passedTrials: 1,
            failedTrials: 0,
            configuredTrials: 1,
          },
        ]),
      }),
    );
    expect(rows[0].verdict.kind).toBe("noMatch");
    expect(rows[0].mark).toBeNull();
  });

  it("calls a legacy run a legacy run, not a failed join", () => {
    // A legacy run HAS no case rows. That is a different answer from "we
    // looked for one and did not find it", and the row says which.
    const rows = buildEvaluateCaseRows(
      input({
        summary: {
          schemaVersion: 1,
          runId: "run_1",
          runStatus: "completed",
          verdict: "failed",
          verdictSource: "legacy",
          diagnostics: { items: [], complete: true, scannedIterations: 1 },
        } as unknown as EvalRunDecisionSummary,
      }),
    );
    expect(rows[0].verdict.kind).toBe("legacyRun");
    expect(rows[0].mark).toBeNull();
  });

  it("withholds a mark when a case's variants disagree", () => {
    const rows = buildEvaluateCaseRows(
      input({
        groups: [
          group({
            key: "g1",
            iterations: [
              iteration("it_1", "passed", {
                caseKey: "hash:abc",
                model: "claude",
              }),
              iteration("it_2", "failed", {
                caseKey: "hash:abc",
                model: "gpt-5",
              }),
            ],
          }),
        ],
        summary: summaryWithCases([
          {
            caseId: "k_hash_abc",
            executionVariant: { model: "claude" },
            verdict: "passed",
            passedTrials: 1,
            failedTrials: 0,
            configuredTrials: 1,
          },
          {
            caseId: "k_hash_abc",
            executionVariant: { model: "gpt-5" },
            verdict: "failed",
            passedTrials: 0,
            failedTrials: 1,
            configuredTrials: 1,
          },
        ]),
      }),
    );
    // Painting one of them would hide the other.
    expect(rows[0].mark).toBeNull();
    expect(rows[0].verdict.kind).toBe("matched");
  });

  it("INVARIANT: an unmatched row never wears a pass word", () => {
    for (const decisionStatus of ["loading", "error", "ready"] as const) {
      const rows = buildEvaluateCaseRows(
        input({
          decisionStatus,
          groups: [
            group({
              key: "g1",
              iterations: [iteration("it_1", "passed")],
            }),
          ],
        }),
      );
      expect(rows[0].mark, decisionStatus).toBeNull();
      // And no string this model produces for such a row may read as one
      // either: the mark is not the only place a false green can appear.
      expect(rows[0].coverage.note ?? "", decisionStatus).not.toMatch(
        PASS_WORDS,
      );
      expect(caseRowReasonLabel(rows[0]) ?? "", decisionStatus).not.toMatch(
        PASS_WORDS,
      );
    }
  });
});

describe("where a case broke", () => {
  it("reads the stage from the chain and never re-derives it", () => {
    const rows = buildEvaluateCaseRows(
      input({ diagnostics: [diagnostic("it_1")] }),
    );
    expect(rows[0].break).toMatchObject({
      kind: "brokeAt",
      stage: "selection",
      reason: "missingToolCall",
    });
    expect(caseRowReasonLabel(rows[0])).toBe(
      "an expected tool call was never made",
    );
  });

  it("tallies breaks per stage across the iterations it has chains for", () => {
    const rows = buildEvaluateCaseRows(
      input({
        groups: [
          group({
            key: "g1",
            iterations: [
              iteration("it_1", "failed"),
              iteration("it_2", "failed"),
              iteration("it_3", "passed"),
            ],
          }),
        ],
        diagnostics: [diagnostic("it_1"), diagnostic("it_2")],
      }),
    );
    expect(rows[0].coverage.breaksByStage.selection).toBe(2);
    expect(rows[0].coverage.breaksByStage.call).toBe(0);
    // The passing iteration's chain was not loaded, so the row says so rather
    // than implying every stage was clean for it.
    expect(rows[0].coverage.note).toBe("chains loaded for 2 of 3 iterations");
  });

  it("says nothing about a location when the chain did not validate", () => {
    const rows = buildEvaluateCaseRows(
      input({
        chains: new Map([
          [
            "it_1",
            {
              status: "unverified",
              analyzerVersion: 8,
            } as EvalRunDecisionChain,
          ],
        ]),
      }),
    );
    expect(rows[0].break.kind).toBe("withheld");
  });

  it("reports no stage for a setup abort", () => {
    const rows = buildEvaluateCaseRows(
      input({
        chains: new Map([
          [
            "it_1",
            {
              status: "verified",
              analyzerVersion: 8,
              stages: [
                {
                  stage: "connection",
                  state: "notMeasured",
                  reason: "setupAborted",
                },
                { stage: "discovery", state: "notMeasured" },
                { stage: "selection", state: "notMeasured" },
                { stage: "call", state: "notMeasured" },
                { stage: "response", state: "notMeasured" },
                { stage: "userValue", state: "notMeasured" },
              ],
            } as EvalRunDecisionChain,
          ],
        ]),
      }),
    );
    expect(rows[0].break).toMatchObject({
      kind: "noFailedStage",
      reason: "setupAborted",
    });
  });
});

describe("ordering and what opens", () => {
  it("puts failures first and passes last", () => {
    const rows = buildEvaluateCaseRows(
      input({
        groups: [
          group({
            key: "pass",
            title: "Draw a rectangle",
            iterations: [
              iteration("p1", "passed", { caseKey: "hash:def" }, "tc_p"),
            ],
          }),
          group({ key: "fail", title: "Draw and share a diagram" }),
        ],
        summary: summaryWithCases([
          {
            caseId: "k_hash_def",
            verdict: "passed",
            passedTrials: 1,
            failedTrials: 0,
            configuredTrials: 1,
          },
          {
            caseId: "k_hash_abc",
            verdict: "failed",
            passedTrials: 0,
            failedTrials: 1,
            configuredTrials: 1,
          },
        ]),
      }),
    );
    expect(rows.map((row) => row.key)).toEqual(["fail", "pass"]);
    expect(defaultOpenCaseRow(rows)).toBe("fail");
  });

  it("opens the failing iteration whose chain explains it", () => {
    const rows = buildEvaluateCaseRows(
      input({
        groups: [
          group({
            key: "g1",
            iterations: [
              iteration("it_1", "failed"),
              iteration("it_2", "failed"),
            ],
          }),
        ],
        // Only the second failing iteration has a chain with a failed stage.
        diagnostics: [diagnostic("it_2")],
      }),
    );
    expect(rows[0].opensIterationId).toBe("it_2");
  });

  it("opens something even when nothing failed", () => {
    const rows = buildEvaluateCaseRows(
      input({
        groups: [
          group({ key: "g1", iterations: [iteration("it_1", "passed")] }),
        ],
      }),
    );
    expect(rows[0].opensIterationId).toBe("it_1");
    expect(defaultOpenCaseRow(rows)).toBeNull();
  });
});
