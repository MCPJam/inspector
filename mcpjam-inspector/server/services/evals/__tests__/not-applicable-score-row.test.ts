import { describe, expect, test } from "vitest";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import { buildHostedScoreContract } from "../score-rows.js";

const declared = { type: "toolResultMatchesSchema", schema: "declared" } as const;

describe("a not-applicable predicate result", () => {
  test("becomes a not-applicable score row, not a pass", () => {
    const { evaluationConfig, scores } = buildHostedScoreContract({
      predicateResults: [
        {
          predicate: declared,
          passed: true,
          status: "not_applicable",
          reason: "no tool declares an output schema",
        },
      ],
    });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      status: "not_applicable",
      rationale: "no tool declares an output schema",
    });
    expect(scores[0]).not.toHaveProperty("value");
    expect(scores[0]).not.toHaveProperty("passed");
    // A required check that does not apply neither passes nor fails the gate.
    expect(allGatingScorersPassed(scores, evaluationConfig).passed).toBe(true);
  });

  test("a scored pass on the same check is a value of 1", () => {
    const { scores } = buildHostedScoreContract({
      predicateResults: [{ predicate: declared, passed: true, reason: "ok" }],
    });
    expect(scores[0]).toMatchObject({ status: "scored", value: 1 });
  });
});
