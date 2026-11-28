import { describe, expect, it } from "vitest";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import { buildHostedScoreContract } from "../score-rows.js";
import {
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
} from "../score-definitions.js";
import { evaluateMultiTurnResults } from "../types.js";

// A case that lists no expected call can still fail the matcher: a negative
// test fails on any call, and a cap on extra calls fails past the cap. Each of
// those failures needs a `toolCalls:match` row, or the rows pass beside a
// recorded failure and nothing says why.

type MatchOptions = Parameters<typeof evaluateMultiTurnResults>[3];

function contract(args: {
  calls: Array<{ toolName: string; arguments: Record<string, unknown> }>;
  isNegativeTest?: boolean;
  matchOptions?: MatchOptions;
  /** The failure path forces this false before grading. */
  forceFailed?: boolean;
}) {
  const evaluation = evaluateMultiTurnResults(
    [{ prompt: "hi", expectedToolCalls: [] }] as never,
    [args.calls],
    args.isNegativeTest,
    args.matchOptions,
  );
  if (args.forceFailed) evaluation.passed = false;
  const built = buildHostedScoreContract({
    evaluation: evaluation as never,
    ...(args.matchOptions
      ? { matchOptions: args.matchOptions as Record<string, unknown> }
      : {}),
    ...(args.isNegativeTest ? { isNegativeTest: true } : {}),
  });
  const ids = built.evaluationConfig.definitions.map((d) => d.scorerId);
  const match = built.scores.find(
    (row) => row.scorerId === HOSTED_TOOL_MATCH_SCORER_ID,
  );
  return { evaluation, built, ids, match };
}

const call = { toolName: "delete_files", arguments: {} };

describe("a negative test", () => {
  it("fails its toolCalls:match row when a tool is called", () => {
    const { evaluation, built, ids, match } = contract({
      calls: [call],
      isNegativeTest: true,
    });

    expect(evaluation.passed).toBe(false);
    expect(ids).toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    expect(ids).not.toContain(HOSTED_TOOL_ARGUMENTS_SCORER_ID);
    expect(match?.passed).toBe(false);
    expect(match?.rationale).toBe("1 tool call(s) made where the case expects none");
    // The rows now agree with the failure the matcher recorded.
    expect(
      allGatingScorersPassed(built.scores, built.evaluationConfig).passed,
    ).toBe(false);
  });

  it("passes it when no tool is called", () => {
    const { match } = contract({ calls: [], isNegativeTest: true });

    expect(match?.passed).toBe(true);
  });

  it("passes it on the failure path when no tool was called before the throw", () => {
    // The iteration failed for another reason, which its own row reports.
    const { match } = contract({
      calls: [],
      isNegativeTest: true,
      forceFailed: true,
    });

    expect(match?.passed).toBe(true);
    expect(match?.rationale).toBe("no tool was called, as the case expects");
  });
});

describe("a case with no expected call", () => {
  it("fails toolCalls:match past its cap on extra calls", () => {
    const { evaluation, built, ids, match } = contract({
      calls: [call],
      matchOptions: { maxExtraToolCalls: 0 },
    });

    expect(evaluation.passed).toBe(false);
    expect(ids).toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    expect(ids).not.toContain(HOSTED_TOOL_ARGUMENTS_SCORER_ID);
    expect(match?.passed).toBe(false);
    expect(
      allGatingScorersPassed(built.scores, built.evaluationConfig).passed,
    ).toBe(false);
  });

  it("passes it within the cap", () => {
    const { match } = contract({
      calls: [call],
      matchOptions: { maxExtraToolCalls: 1 },
    });

    expect(match?.passed).toBe(true);
  });

  it("declares no tool scorer without a cap, since it claims nothing", () => {
    const { ids } = contract({ calls: [call] });

    expect(ids).not.toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    expect(ids).not.toContain(HOSTED_TOOL_ARGUMENTS_SCORER_ID);
  });
});
