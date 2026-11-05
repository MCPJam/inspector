import { describe, expect, it } from "vitest";
import type { EvalRunDecisionDiagnostic } from "@mcpjam/sdk/contract";
import { USER_VALUE_STAGES } from "@mcpjam/sdk/contract";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import {
  buildTestRunFindings,
  caseTargets,
  pickTarget,
  representativeIteration,
} from "../test-run-model";

function iteration(
  id: string,
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: "r_1",
    testCaseId: "c_1",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    startedAt: 1,
    updatedAt: 2,
    testCaseSnapshot: {
      title: "Draw a diagram",
      model: "gpt-5-mini",
      provider: "openai",
      query: "Draw",
      expectedToolCalls: [],
    },
    ...overrides,
  } as EvalIteration;
}

const run = {
  _id: "r_1",
  suiteId: "s_1",
  runNumber: 4,
  status: "completed",
  configSnapshot: { tests: [], environment: { servers: [] } },
} as unknown as EvalSuiteRun;

function brokeAtSelection(
  iterationId: string,
  testCaseId = "c_1",
): EvalRunDecisionDiagnostic {
  return {
    iterationId,
    iterationNumber: 1,
    testCaseId,
    status: "completed",
    result: "failed",
    chain: {
      status: "verified",
      analyzerVersion: 1,
      firstFailedStage: "selection",
      stages: USER_VALUE_STAGES.map((stage) => ({
        stage,
        state: stage === "selection" ? "failed" : "passed",
      })),
    },
    evidence: { iterationId },
    nextAction: "Open the exemplar sessions.",
  } as unknown as EvalRunDecisionDiagnostic;
}

describe("test run model", () => {
  const matrix = buildRunResultsMatrix({
    run,
    runs: [],
    iterations: [
      iteration("a"),
      iteration("b", {
        testCaseSnapshot: {
          title: "Draw a diagram",
          model: "claude-haiku-4.5",
          provider: "anthropic",
          query: "Draw",
          expectedToolCalls: [],
        },
      }),
    ],
    hostNamesById: new Map(),
  });

  it("offers one target per model that ran the case", () => {
    const targets = caseTargets(matrix, "c_1");
    expect(targets.map((target) => target.targetKey).sort()).toEqual([
      "claude-haiku-4.5",
      "gpt-5-mini",
    ]);
    expect(caseTargets(matrix, "other")).toEqual([]);
  });

  it.each([
    ["claude-haiku-4.5", "claude-haiku-4.5"],
    [undefined, "first"],
    ["deleted-model", "first"],
  ])("picks the target %s", (key, expected) => {
    const targets = caseTargets(matrix, "c_1");
    const picked = pickTarget(targets, key);
    expect(picked?.targetKey).toBe(
      expected === "first" ? targets[0].targetKey : expected,
    );
  });

  it("scores the first failing iteration, else the first", () => {
    const failed = iteration("f", { result: "failed" });
    expect(representativeIteration([iteration("p"), failed])).toBe(failed);
    expect(representativeIteration([iteration("p")])?._id).toBe("p");
    expect(representativeIteration([])).toBeNull();
  });

  it("groups this case's failures by the stage they broke at", () => {
    const findings = buildTestRunFindings(
      [
        brokeAtSelection("i_1"),
        brokeAtSelection("i_2"),
        brokeAtSelection("i_9", "other_case"),
      ],
      "c_1",
      8,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      key: "selection",
      sentence: "2 of 8 iterations broke at Selection.",
      nextAction: "Open the exemplar sessions.",
      iterationId: "i_1",
      count: 2,
    });
  });
});
