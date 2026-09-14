/**
 * How "nothing ran" projects into the score contract.
 *
 * An ERROR row on a GATING scorer, which is a deliberate pair of choices:
 *
 *  - ERROR rather than a failed criterion, because "nothing ran" is a
 *    statement about MEASUREMENT. An error row carries no value, keeps the
 *    scorer in `unresolvedScorerIds`, and leaves its stage `notMeasured`;
 *    a 0 would attribute a defect to the server on a run that never happened.
 *  - GATING rather than advisory, because the whole point is that the result
 *    must not stand as a clean pass.
 *
 * And the definition is pushed ONLY when the guard fired, so every recorded
 * `evaluationConfigHash` for a normal run stays byte-identical.
 */
import { describe, expect, it } from "vitest";
import { buildHostedScoreContract } from "../score-rows.js";
import { HOSTED_AGENT_ACTIVITY_SCORER_ID } from "../score-definitions.js";

const evaluation = {
  passed: true,
  toolsCalled: [{ toolName: "list_files" }],
  expectedToolCalls: ["list_files"],
  missing: [],
  unexpected: [],
  argumentMismatches: [],
} as never;

describe("the agent-activity projection", () => {
  it("projects no_agent_activity as an error row on a gating scorer", () => {
    const { evaluationConfig, scores } = buildHostedScoreContract({
      evaluation,
      agentActivity: {
        status: "no_agent_activity",
        detail: "the agent made no tool calls and the model was never invoked",
      },
    });
    const definition = evaluationConfig.definitions.find(
      (candidate) => candidate.scorerId === HOSTED_AGENT_ACTIVITY_SCORER_ID,
    );
    expect(definition?.role).toBe("gating");
    expect(definition?.deterministic).toBe(true);

    const row = scores.find(
      (score) => score.scorerId === HOSTED_AGENT_ACTIVITY_SCORER_ID,
    );
    expect(row?.status).toBe("error");
    // UNRESOLVED, not failed: the row carries no value at all.
    expect(row).not.toHaveProperty("value");
    expect(JSON.stringify(row)).toContain("no_agent_activity");
  });

  it("emits NO definition and NO row when the guard did not fire", () => {
    // The compatibility guarantee. A definition on every iteration would
    // rotate every recorded `evaluationConfigHash` and put an always-passing
    // row on every result, to say something true of almost none of them.
    for (const agentActivity of [
      undefined,
      { status: "active" as const },
      { status: "exempt" as const, reason: "model_free" as const },
    ]) {
      const { evaluationConfig, scores } = buildHostedScoreContract({
        evaluation,
        ...(agentActivity ? { agentActivity } : {}),
      });
      expect(
        evaluationConfig.definitions.map((d) => d.scorerId),
      ).not.toContain(HOSTED_AGENT_ACTIVITY_SCORER_ID);
      expect(scores.map((s) => s.scorerId)).not.toContain(
        HOSTED_AGENT_ACTIVITY_SCORER_ID,
      );
    }
  });

  it("leaves the evaluationConfigHash untouched for a normal run", () => {
    // Stated as an equality rather than trusted from the case above: the hash
    // is what joins a recorded row to its definition, and a rotation would
    // orphan every row already in the database.
    const without = buildHostedScoreContract({ evaluation });
    const active = buildHostedScoreContract({
      evaluation,
      agentActivity: { status: "active" },
    });
    expect(active.evaluationConfig).toEqual(without.evaluationConfig);
  });

  it("does not disturb the tool-match row it sits beside", () => {
    // The guard adds a row; it does not rewrite the matcher's.
    const { scores } = buildHostedScoreContract({
      evaluation,
      agentActivity: { status: "no_agent_activity", detail: "nothing ran" },
    });
    const toolMatch = scores.find(
      (score) => score.scorerId === "toolCalls:match",
    );
    expect(toolMatch?.status).not.toBe("error");
  });
});
