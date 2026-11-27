import { describe, expect, test } from "vitest";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import { buildHostedScoreContract } from "../score-rows.js";

const verdict = {
  status: "scored",
  templateVersion: 1,
  model: "openai/gpt-5.4-mini",
  goalCompletionJobId: "job1",
  judges: [
    {
      id: "cites-order",
      label: "Cites the order number",
      contentDigest: "d-cites",
      output: { kind: "passfail" },
      status: "scored",
      value: 1,
      passed: true,
      reason: "States order 42.",
    },
    {
      id: "helpful",
      label: "Helpful",
      contentDigest: "d-helpful",
      output: { kind: "score", threshold: 0.7 },
      status: "scored",
      value: 0.4,
      passed: false,
      reason: "Terse.",
    },
    {
      id: "grounded",
      label: "Grounded",
      contentDigest: "d-grounded",
      output: { kind: "passfail" },
      status: "error",
      error: "variable_missing",
      reason: "No data for {{tool_results}} on this iteration.",
    },
    { id: "Bad Id", contentDigest: "x", output: { kind: "passfail" } },
  ],
};

const contract = (customJudgesVerdict: Record<string, unknown>) =>
  buildHostedScoreContract({ customJudgesVerdict });

describe("custom judge rows", () => {
  test("one advisory row per well-formed judge, keyed judge:custom:<id>", () => {
    const { evaluationConfig, scores } = contract(verdict);
    expect(evaluationConfig.definitions.map((d) => d.scorerId).sort()).toEqual([
      "judge:custom:cites-order",
      "judge:custom:grounded",
      "judge:custom:helpful",
    ]);
    expect(evaluationConfig.definitions.every((d) => d.role === "advisory")).toBe(
      true,
    );
    const byId = new Map(scores.map((row) => [row.scorerId, row]));
    expect(byId.get("judge:custom:cites-order")).toMatchObject({
      status: "scored",
      value: 1,
      passed: true,
      rationale: "States order 42.",
    });
    expect(byId.get("judge:custom:helpful")).toMatchObject({
      value: 0.4,
      passed: false,
      passThreshold: 0.7,
    });
  });

  test("an unanswered judge is an error row, never a zero", () => {
    const row = contract(verdict).scores.find(
      (r) => r.scorerId === "judge:custom:grounded",
    )!;
    expect(row.status).toBe("error");
    expect(row.value).toBeUndefined();
    expect(row.error).toContain("variable_missing");
  });

  test("renaming keeps the definition; a new digest is a new one", () => {
    const base = contract(verdict).evaluationConfig.definitions.find(
      (d) => d.scorerId === "judge:custom:cites-order",
    )!;
    const renamed = contract({
      ...verdict,
      judges: [{ ...verdict.judges[0], label: "Renamed" }],
    }).evaluationConfig.definitions[0];
    const reworded = contract({
      ...verdict,
      judges: [{ ...verdict.judges[0], contentDigest: "d-cites-2" }],
    }).evaluationConfig.definitions[0];
    expect(renamed.implementationHash).toBe(base.implementationHash);
    expect(reworded.implementationHash).not.toBe(base.implementationHash);
  });

  test("cannot move a gate", () => {
    const { evaluationConfig, scores } = contract(verdict);
    expect(allGatingScorersPassed(scores, evaluationConfig).passed).toBe(true);
  });
});
