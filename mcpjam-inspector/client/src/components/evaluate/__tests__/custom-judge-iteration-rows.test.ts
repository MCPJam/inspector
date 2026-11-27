import { describe, expect, it } from "vitest";
import {
  buildEvaluationConfigSnapshot,
  errorScoreResult,
  finalizeScoreResult,
  resolveScoreDefinition,
  type ScoreDefinition,
} from "@mcpjam/sdk/contract";
import type { EvalIteration } from "@/components/evals/types";
import { customJudgeIterationRows } from "../case-scorecard/custom-judge-iteration-rows";

const answersId = "answers-the-question-answers";

const answersDefinition: ScoreDefinition = {
  scorerId: `judge:custom:${answersId}`,
  idSource: "platform",
  scorerVersion: "1",
  implementationHash: "impl-judge",
  label: "custom judge: Answers what the user asked",
  deterministic: false,
  passThreshold: 0.7,
  role: "advisory",
};

function iteration(metadata: Record<string, unknown>): EvalIteration {
  return {
    _id: "it1",
    createdBy: "user1",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 0,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    metadata,
  };
}

function projected(value: number, rationale: string) {
  return {
    evaluationConfig: buildEvaluationConfigSnapshot([answersDefinition]),
    scores: [
      finalizeScoreResult(resolveScoreDefinition(answersDefinition), {
        kind: "scored",
        value,
        rationale,
      }),
    ],
  };
}

function savedVerdict(judge: Record<string, unknown>) {
  return {
    judges: [
      {
        id: answersId,
        label: "Answers what the user asked",
        evaluator: { id: "answers-the-question", version: 1 },
        output: { kind: "score", threshold: 0.7 },
        ...judge,
      },
    ],
  };
}

describe("custom judge rows on an iteration", () => {
  it("shows the projected row over the saved verdict, with the verdict's origin", () => {
    const rows = customJudgeIterationRows(
      iteration({
        ...projected(0.9, "Projected reason"),
        customJudgesVerdict: savedVerdict({
          status: "scored",
          passed: false,
          value: 0.4,
          reason: "Saved reason",
        }),
      }),
    );
    expect(rows).toMatchObject([
      {
        key: `judge:custom:${answersId}`,
        provenance: "customJudge",
        join: { kind: "judge", slot: "customJudges" },
        label: "Answers what the user asked",
        customJudge: {
          id: answersId,
          evaluatorId: "answers-the-question",
          outputKind: "score",
        },
        expectation: "Score of 0.7 or higher",
        result: {
          state: "passed",
          source: "scoreRow",
          value: 0.9,
          threshold: 0.7,
          reason: "Projected reason",
        },
      },
    ]);
  });

  it("stands in with the saved verdict until the projection arrives", () => {
    const rows = customJudgeIterationRows(
      iteration({
        customJudgesVerdict: savedVerdict({
          status: "scored",
          passed: false,
          value: 0.699,
          reason: "Misses the question.",
        }),
      }),
    );
    expect(rows).toMatchObject([
      {
        provenance: "customJudge",
        result: {
          state: "failed",
          source: "modelVerdict",
          value: 0.699,
          threshold: 0.7,
          reason: "Misses the question.",
        },
      },
    ]);
  });

  it("shows a projected error's reason without the code in front of it", () => {
    const rows = customJudgeIterationRows(
      iteration({
        evaluationConfig: buildEvaluationConfigSnapshot([answersDefinition]),
        scores: [
          errorScoreResult(
            resolveScoreDefinition(answersDefinition),
            "custom_judge_cap_reached: This run reached its spending limit for custom judges.",
          ),
        ],
      }),
    );
    expect(rows[0]?.result).toEqual({
      state: "error",
      source: "scoreRow",
      reason: "This run reached its spending limit for custom judges.",
    });
  });

  it("gives readable copy for a saved error with a code and no reason", () => {
    const rows = customJudgeIterationRows(
      iteration({
        customJudgesVerdict: savedVerdict({
          status: "error",
          error: "spend_budget_reached",
        }),
      }),
    );
    expect(rows[0]?.result).toMatchObject({
      state: "error",
      reason: expect.stringContaining("spend budget is reached"),
    });
    const lost = customJudgeIterationRows(
      iteration({
        customJudgesVerdict: savedVerdict({ status: "error", error: "lease_lost" }),
      }),
    );
    expect(lost[0]?.result).toMatchObject({
      reason: expect.stringContaining("Grading restarted"),
    });
  });

  it("reads a pass-or-fail judge as Pass, not as a score line", () => {
    const rows = customJudgeIterationRows(
      iteration({
        customJudgesVerdict: savedVerdict({
          output: { kind: "passfail" },
          status: "scored",
          passed: true,
          value: 1,
          reason: "Answered.",
        }),
      }),
    );
    expect(rows[0]).toMatchObject({
      expectation: "Pass",
      customJudge: { outputKind: "passfail" },
    });
  });
});
