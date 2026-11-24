import { describe, expect, it } from "vitest";
import { environmentTone, verdictSentence } from "../round-verdict";
import { makeRoundDetail } from "./fixtures";

const labels = { env_a: "MCPJam · Sonnet", env_b: "Claude Code · Sonnet" };
const context = { labels, measure: "pass_rate" as const, serverName: "mcpjam-mcp" };

describe("environmentTone", () => {
  const round = makeRoundDetail();
  it("is better when the measure moved the right way, same when nothing moved, worse when anything got worse", () => {
    expect(environmentTone(round.environments[0], "pass_rate")).toBe("better");
    expect(environmentTone(round.environments[1], "pass_rate")).toBe("same");
    const worse = { ...round.environments[0], validation: { passRate: { ...round.environments[0].validation!.passRate!, move: "worse" as const } } };
    expect(environmentTone(worse, "pass_rate")).toBe("worse");
  });
  it("reads the measure's move on a climb for tokens", () => {
    const env = { ...makeRoundDetail().environments[0], steering: { measure: { ratioBps: 7000, noiseBps: 200, comparedCases: 4, move: "better" as const } } };
    expect(environmentTone(env, "tokens")).toBe("better");
  });
  it("is none without steering numbers", () => {
    expect(environmentTone({ ...round.environments[0], steering: undefined }, "pass_rate")).toBe("none");
  });
});

describe("verdictSentence", () => {
  it("says a kept round's gain and that validation cases went up too", () => {
    const text = verdictSentence(makeRoundDetail({ validation: "better" }), context);
    expect(text.lead).toBe("Kept.");
    expect(text.rest).toBe("MCPJam · Sonnet went from 78% to 94%. Validation cases went up too.");
  });
  it("says validation cases did not move when they did not", () => {
    expect(verdictSentence(makeRoundDetail(), context).rest).toContain("Validation cases didn't move.");
  });
  it("says a climb for tokens in tokens", () => {
    const round = makeRoundDetail({
      environments: [{ environmentId: "env_a", candidateLost: 0, bestLost: 0, measureRecorded: true, steering: { measure: { ratioBps: 6900, noiseBps: 200, comparedCases: 6, move: "better" } } }],
    });
    expect(verdictSentence(round, { ...context, measure: "tokens" }).rest).toContain("tokens 31% lower");
  });
  it("names where a reverted round went down", () => {
    const base = makeRoundDetail();
    const round = makeRoundDetail({
      standing: "reverted",
      verdict: "reverted",
      reasons: ["pass_rate_worse"],
      environments: [{ ...base.environments[0], steering: { passRate: { bestBps: 9000, candidateBps: 7000, deltaBps: -2000, noiseBps: 560, move: "worse" } } }],
    });
    expect(verdictSentence(round, context)).toEqual({ lead: "Reverted.", rest: "Pass rate went down on MCPJam · Sonnet." });
  });
  it("explains a round that could not be decided", () => {
    const round = makeRoundDetail({ verdict: "not_decided", standing: "not_decided", reasons: ["real_server_changed"] });
    expect(verdictSentence(round, context)).toEqual({
      lead: "Not decided.",
      rest: "mcpjam-mcp changed since the best so far was measured, so the two results can't be compared.",
    });
  });
  it("records who overruled the rule and why, after what the rule decided", () => {
    const round = makeRoundDetail({
      verdict: "reverted",
      standing: "kept",
      reasons: ["no_improvement"],
      overruled: { to: "kept", by: "Casey", reason: "It reads better.", at: 1 },
    });
    const { lead, rest } = verdictSentence(round, context);
    expect(lead).toBe("Kept.");
    expect(rest).toContain("No environment improved beyond the noise.");
    expect(rest).toContain("The rule reverted it. Overruled to kept by Casey: It reads better.");
  });
  it("says a round did not finish, with the backend's reason", () => {
    const round = makeRoundDetail({ status: "failed", verdict: undefined, standing: undefined, failureReason: "A run passed its deadline. Submit the change again." });
    expect(verdictSentence(round, context)).toEqual({ lead: "Did not finish.", rest: "A run passed its deadline. Submit the change again." });
  });
});
