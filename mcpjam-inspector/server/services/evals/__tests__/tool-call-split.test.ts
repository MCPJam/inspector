import { describe, expect, test } from "vitest";
import { allGatingScorersPassed, canonicalDigest } from "@mcpjam/sdk/contract";
import {
  resolveMatchOptions,
  type EvalMatchOptions,
} from "@mcpjam/sdk/matchers";
import type { PromptTurn } from "@/shared/steps";
import { buildHostedScoreContract } from "../score-rows.js";
import { evaluateMultiTurnResults, type ToolCall } from "../types.js";
import {
  HOSTED_TOOL_ARGUMENTS_EVALUATOR_VERSION,
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_EVALUATOR_VERSION,
  HOSTED_TOOL_MATCH_SCORER_ID,
  hostedToolArgumentsScoreDefinition,
  hostedToolMatchScoreDefinition,
} from "../score-definitions.js";

// =============================================================================
// `toolCalls:match` split at the chain's stages.
//
// v2 was ONE row for the whole matcher verdict, filed at Selection, so a right
// tool called with the wrong argument read as a wrong route. v3 keeps the id
// and narrows it to WHICH tools were called; `toolCalls:arguments` is HOW the
// expected ones were called, filed at Tool call.
//
// The property that makes the split safe to ship is the last block below: the
// two rows pass together exactly when the matcher did, so a gate on the pair
// means what a gate on the old row meant. Everything is run through the real
// matcher (`evaluateMultiTurnResults`), never hand-built verdicts.
// =============================================================================

const call = (
  toolName: string,
  args: Record<string, unknown> = {},
): ToolCall => ({
  toolName,
  arguments: args,
});

const turn = (expected: ToolCall[], index = 0): PromptTurn => ({
  id: `turn-${index + 1}`,
  prompt: `ask ${index + 1}`,
  expectedToolCalls: expected,
});

function grade(args: {
  turns: PromptTurn[];
  actual: ToolCall[][];
  matchOptions?: EvalMatchOptions;
}) {
  const options = resolveMatchOptions(undefined, args.matchOptions);
  const evaluation = evaluateMultiTurnResults(
    args.turns,
    args.actual,
    false,
    options,
  );
  const contract = buildHostedScoreContract({
    evaluation,
    matchOptions: options as unknown as Record<string, unknown>,
  });
  const row = (id: string) => contract.scores.find((s) => s.scorerId === id);
  return {
    evaluation,
    ...contract,
    match: row(HOSTED_TOOL_MATCH_SCORER_ID),
    args: row(HOSTED_TOOL_ARGUMENTS_SCORER_ID),
  };
}

describe("right tool, wrong arguments", () => {
  test("passes Selection and fails Tool call, naming the tool and the argument", () => {
    const graded = grade({
      turns: [
        turn([call("create_journey", { host: "secret-host-1", name: "x" })]),
      ],
      actual: [[call("create_journey", { host: "secret-host-2", name: "x" })]],
    });

    expect(graded.evaluation.passed).toBe(false);
    expect(graded.match).toMatchObject({ passed: true });
    expect(graded.args).toMatchObject({ passed: false });
    expect(graded.args?.rationale).toBe(
      "`create_journey` was called with a different `host` than expected",
    );
    // Names, never values: an argument can carry anything.
    expect(graded.args?.rationale).not.toContain("secret");
  });

  test("exact matching also names an argument the call added", () => {
    const graded = grade({
      turns: [turn([call("get_me", { id: 1 })])],
      actual: [[call("get_me", { id: 1, verbose: true })]],
      matchOptions: { argumentMatching: "exact" },
    });
    expect(graded.args?.rationale).toBe(
      "`get_me` was called with a different `verbose` than expected",
    );
  });

  test("a placeholder means here what it meant to the matcher", () => {
    const wrongType = grade({
      turns: [turn([call("get_me", { id: "number", name: "string" })])],
      actual: [[call("get_me", { id: "7", name: "Ada" })]],
    });
    expect(wrongType.args?.rationale).toBe(
      "`get_me` was called with a different `id` than expected",
    );
    const rightType = grade({
      turns: [turn([call("get_me", { id: "number" })])],
      actual: [[call("get_me", { id: 7 })]],
    });
    expect(rightType.args).toMatchObject({ passed: true });
  });

  test("names the turn on a multi-turn case, and bounds the list", () => {
    const expected = ["a", "b", "c", "d", "e"].map((name) =>
      call(name, { id: 1 }),
    );
    const graded = grade({
      turns: [turn([call("first")]), turn(expected, 1)],
      actual: [
        [call("first")],
        expected.map((c) => call(c.toolName, { id: 2 })),
      ],
    });
    expect(graded.args?.rationale).toBe(
      "turn 2: `a` was called with a different `id` than expected; " +
        "turn 2: `b` was called with a different `id` than expected; " +
        "turn 2: `c` was called with a different `id` than expected; " +
        "and 2 more",
    );
  });
});

describe("what Selection alone decides", () => {
  test("a missing call fails Selection, and leaves Tool call nothing to fail", () => {
    const graded = grade({
      turns: [turn([call("get_me")])],
      actual: [[call("list_files")]],
    });
    expect(graded.match).toMatchObject({ passed: false });
    expect(graded.match?.rationale).toBe("tool selection unmet: 1 missing");
    // Scored, not skipped: a gating row with no verdict is an unresolved gate.
    expect(graded.args).toMatchObject({ status: "scored", passed: true });
    expect(graded.args?.rationale).toBe(
      "no expected call was matched, so there were no arguments to compare",
    );
  });

  test("reads the extras cap per turn, as the matcher applies it", () => {
    const perTurn = grade({
      turns: [turn([call("a")]), turn([call("b")], 1)],
      actual: [
        [call("a"), call("x")],
        [call("b"), call("y")],
      ],
      matchOptions: { maxExtraToolCalls: 1 },
    });
    // One extra in each turn: within a cap of one, though two overall.
    expect(perTurn.match).toMatchObject({ passed: true });

    const over = grade({
      turns: [turn([call("a")])],
      actual: [[call("a"), call("x"), call("y")]],
      matchOptions: { maxExtraToolCalls: 1 },
    });
    expect(over.match).toMatchObject({ passed: false });
    expect(over.match?.rationale).toBe(
      "tool selection unmet: 2 unexpected (at most 1 allowed per turn)",
    );
  });

  test("order folds in through missing and extra calls", () => {
    const graded = grade({
      turns: [turn([call("a"), call("b")])],
      actual: [[call("b"), call("a")]],
      matchOptions: { toolCallOrder: "strict" },
    });
    expect(graded.match).toMatchObject({ passed: false });
    expect(graded.args).toMatchObject({ passed: true });
  });
});

describe("when the arguments scorer exists", () => {
  test("not when arguments are ignored: nothing is compared", () => {
    const graded = grade({
      turns: [turn([call("get_me", { id: 1 })])],
      actual: [[call("get_me", { id: 2 })]],
      matchOptions: { argumentMatching: "ignore" },
    });
    expect(
      graded.evaluationConfig.definitions.map((d) => d.scorerId),
    ).not.toContain(HOSTED_TOOL_ARGUMENTS_SCORER_ID);
    expect(graded.args).toBeUndefined();
    expect(graded.match).toMatchObject({ passed: true });
  });

  test("not on a negative case: there is no expected call to compare", () => {
    const { evaluationConfig } = buildHostedScoreContract({
      toolMatchAuthored: true,
      isNegativeTest: true,
    });
    const ids = evaluationConfig.definitions.map((d) => d.scorerId);
    expect(ids).toContain(HOSTED_TOOL_MATCH_SCORER_ID);
    expect(ids).not.toContain(HOSTED_TOOL_ARGUMENTS_SCORER_ID);
  });

  test("declared with the definition's own precondition, without a row", () => {
    // The judge second pass holds the case but not the matcher's output.
    const { scores, evaluationConfig } = buildHostedScoreContract({
      toolMatchAuthored: true,
    });
    expect(evaluationConfig.definitions.map((d) => d.scorerId)).toEqual([
      HOSTED_TOOL_MATCH_SCORER_ID,
      HOSTED_TOOL_ARGUMENTS_SCORER_ID,
    ]);
    expect(scores).toEqual([]);
  });

  test("gates, at threshold 1, under a digest that covers the pairing options", () => {
    const definition = hostedToolArgumentsScoreDefinition({
      matchOptions: { toolCallOrder: "ignore" },
    });
    expect(definition).toMatchObject({
      scorerId: HOSTED_TOOL_ARGUMENTS_SCORER_ID,
      idSource: "platform",
      scorerVersion: HOSTED_TOOL_ARGUMENTS_EVALUATOR_VERSION,
      deterministic: true,
      passThreshold: 1,
    });
    expect(definition.implementationHash).toBe(
      canonicalDigest({
        evaluatorVersion: HOSTED_TOOL_ARGUMENTS_EVALUATOR_VERSION,
        matchOptions: { toolCallOrder: "ignore" },
      }),
    );
    // Which actual call an expected one is compared against is the pairing,
    // and the order option decides the pairing.
    expect(definition.implementationHash).not.toBe(
      hostedToolArgumentsScoreDefinition({
        matchOptions: { toolCallOrder: "strict" },
      }).implementationHash,
    );
  });

  test("the selection scorer is v3, so its digest moved on purpose", () => {
    expect(HOSTED_TOOL_MATCH_EVALUATOR_VERSION).toBe("3");
    expect(hostedToolMatchScoreDefinition({}).implementationHash).not.toBe(
      canonicalDigest({ evaluatorVersion: "2", matchOptions: {} }),
    );
  });
});

describe("the two rows pass together exactly when the matcher did", () => {
  const corpus: Array<{
    name: string;
    turns: PromptTurn[];
    actual: ToolCall[][];
    matchOptions?: EvalMatchOptions;
  }> = [
    {
      name: "all right",
      turns: [turn([call("a", { id: 1 })])],
      actual: [[call("a", { id: 1 })]],
    },
    {
      name: "wrong argument",
      turns: [turn([call("a", { id: 1 })])],
      actual: [[call("a", { id: 2 })]],
    },
    { name: "missing", turns: [turn([call("a")])], actual: [[]] },
    { name: "wrong tool", turns: [turn([call("a")])], actual: [[call("b")]] },
    {
      name: "missing and wrong argument",
      turns: [turn([call("a", { id: 1 }), call("b")])],
      actual: [[call("a", { id: 2 })]],
    },
    {
      name: "extras past the cap",
      turns: [turn([call("a")])],
      actual: [[call("a"), call("x")]],
      matchOptions: { maxExtraToolCalls: 0 },
    },
    {
      name: "extras past the cap and a wrong argument",
      turns: [turn([call("a", { id: 1 })])],
      actual: [[call("a", { id: 2 }), call("x")]],
      matchOptions: { maxExtraToolCalls: 0 },
    },
    {
      name: "strict order broken",
      turns: [turn([call("a"), call("b")])],
      actual: [[call("b"), call("a")]],
      matchOptions: { toolCallOrder: "strict" },
    },
    {
      name: "superset with a gap",
      turns: [turn([call("a"), call("b")])],
      actual: [[call("a"), call("x"), call("b")]],
      matchOptions: { toolCallOrder: "superset" },
    },
    {
      name: "exact with an added argument",
      turns: [turn([call("a", { id: 1 })])],
      actual: [[call("a", { id: 1, more: true })]],
      matchOptions: { argumentMatching: "exact" },
    },
    {
      name: "second turn wrong, first right",
      turns: [turn([call("a")]), turn([call("b", { id: 1 })], 1)],
      actual: [[call("a")], [call("b", { id: 9 })]],
    },
    {
      name: "a turn with no expectation calling past the cap",
      turns: [turn([call("a")]), turn([], 1)],
      actual: [[call("a")], [call("x")]],
      matchOptions: { maxExtraToolCalls: 0 },
    },
  ];

  test.each(corpus)("$name", ({ turns, actual, matchOptions }) => {
    const graded = grade({ turns, actual, matchOptions });
    expect(graded.match?.status).toBe("scored");
    expect(graded.args?.status).toBe("scored");
    expect(graded.match!.passed! && graded.args!.passed!).toBe(
      graded.evaluation.passed,
    );
    // And through the contract's own arithmetic: nothing left unresolved.
    const verdict = allGatingScorersPassed(
      graded.scores,
      graded.evaluationConfig,
    );
    expect(verdict.unresolvedScorerIds).toEqual([]);
    expect(verdict.passed).toBe(graded.evaluation.passed);
  });
});
