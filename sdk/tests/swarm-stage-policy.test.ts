import { describe, expect, it } from "vitest";
import { buildChatSessionStageInput } from "../src/contract/chat-session-stage-adapter.js";
import { deriveStageResults } from "../src/contract/stage-derivation.js";
describe("swarm stage policy", () => {
  for (const passed of [true, false])
    it(`advisory results retain decisive judge ${passed}`, () => {
      const input = buildChatSessionStageInput({
        source: "swarm",
        hasUserAsk: true,
        lifecycle: "settled",
        swarmPolicy: { judgeDecisive: true, requiredCriteria: 0 },
        criteria: {
          status: "completed",
          results: [
            {
              criterionId: "tool-errors",
              passed: !passed,
              status: "scored",
              predicate: { type: "noToolErrors", role: "advisory" },
            },
          ],
        },
        goalJudge: { status: "completed", passed },
      });
      expect(input.evidence.judgeEvidence).toMatchObject({
        status: "scored",
        verdict: passed ? "pass" : "fail",
      });
      const result = deriveStageResults(input);
      expect(
        result.stageResults.find((s) => s.stage === "userValue")?.state
      ).toBe(passed ? "passed" : "failed");
    });
  it("an advisory evaluator error does not suppress the judge", () => {
    const input = buildChatSessionStageInput({
      source: "swarm",
      hasUserAsk: true,
      lifecycle: "settled",
      swarmPolicy: { judgeDecisive: true, requiredCriteria: 0 },
      criteria: { status: "failed" },
      goalJudge: { status: "completed", passed: true },
    });
    expect(input.evidence.evaluatorErrored).toBeUndefined();
    expect(input.evidence.judgeEvidence?.status).toBe("scored");
  });
});

it("required checks pending cannot borrow a passing judge", () => {
  const input = buildChatSessionStageInput({
    source: "swarm",
    hasUserAsk: true,
    lifecycle: "settled",
    swarmPolicy: { judgeDecisive: true, requiredCriteria: 1 },
    criteria: { status: "pending" },
    goalJudge: { status: "completed", passed: true },
  });
  expect(
    deriveStageResults(input).stageResults.find((r) => r.stage === "userValue")
  ).toMatchObject({ state: "notMeasured", reason: "judgePending" });
});

it.each(["failed", "completed"] as const)(
  "a required judge failure survives broken required checks (%s)",
  (status) => {
    const input = buildChatSessionStageInput({
      source: "swarm",
      hasUserAsk: true,
      lifecycle: "settled",
      swarmPolicy: { judgeDecisive: true, requiredCriteria: 1 },
      criteria: {
        status,
        results: [
          {
            criterionId: "broken",
            passed: false,
            status: "error",
            predicate: { type: "responseContains", role: "required" },
          },
        ],
      },
      goalJudge: { status: "completed", passed: false },
    });
    expect(
      deriveStageResults(input).stageResults.find(
        (r) => r.stage === "userValue"
      )
    ).toMatchObject({ state: "failed" });
  }
);
