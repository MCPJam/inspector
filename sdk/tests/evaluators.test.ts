/**
 * The evaluator runtime, against the constructors it is the canonical spelling
 * of.
 *
 * The load-bearing claim is equality, not similarity: `assertion(rule)` and
 * `predicateScorer(rule)` must produce the same definition, and `judge(options)`
 * and `judgeScorer(options)` must produce the same one, down to the
 * `implementationHash`. If they differ by a byte, migrating a single rule
 * changes the evaluation config hash of its whole suite and every comparison
 * against an earlier run reads the migration as a regression.
 */

import { describe, expect, it, vi } from "vitest";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
  };
});
vi.mock("../src/model-factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-factory.js")>();
  return {
    ...actual,
    createModelFromString: () => ({ modelId: "test-model" }) as never,
  };
});

const { assertion, judge, runEvaluators, runEvaluatorsProjected, evaluatorsPassed } =
  await import("../src/evaluators/index.js");
const { predicateScorer, judgeScorer } = await import("../src/scorers/index.js");
const { resolveScoreDefinition, definitionHash } = await import(
  "../src/contract/derive.js"
);
const { buildEvaluationConfigSnapshot } = await import(
  "../src/contract/derive.js"
);
const { canonicalDigest } = await import("../src/contract/canonical.js");

type Assertion = import("../src/predicates/types.js").Predicate;
type ScorerContextV1 = import("../src/contract/types.js").ScorerContextV1;

const RULE: Assertion = { type: "responseContains", needle: "refund" };

function context(finalMessage: string): ScorerContextV1 {
  return {
    version: 1,
    scenario: { title: "t" },
    transcript: {
      finalAssistantMessage: finalMessage,
      toolCalls: [],
      toolResults: [],
      toolErrors: [],
    } as never,
    trace: { messages: [] },
  };
}

const JUDGE_OPTIONS = {
  id: "policy-grounding",
  model: "anthropic/claude-sonnet-4-6",
  apiKey: "sk-test",
  rubric: ["The answer cites the retrieved policy."],
} as const;

describe("assertion() is predicateScorer() under its canonical name", () => {
  it("builds a byte-identical definition", () => {
    expect(assertion(RULE).definition).toEqual(predicateScorer(RULE).definition);
  });

  it("mints the same opaque id, content-derived and not gateable", () => {
    const built = assertion(RULE).definition;
    expect(built.scorerId).toBe(
      `predicate:${RULE.type}#${canonicalDigest(RULE)}`,
    );
    // A content-derived id is still `generated`: content-stable is not
    // author-stable, and a gate must not select one.
    expect(built.idSource).toBe("generated");
  });

  it("keeps a name out of the implementation hash", () => {
    const named = assertion({ ...RULE, id: "refund-mentioned" });
    const anonymous = assertion(RULE);

    expect(named.definition.scorerId).toBe("refund-mentioned");
    expect(named.definition.idSource).toBe("explicit");
    // Naming a rule must not change the digest of what that rule DOES, or
    // every comparison would read the naming as an edit to the rule.
    expect(named.definition.implementationHash).toBe(
      anonymous.definition.implementationHash,
    );
  });

  it("hashes identically to the legacy definition once resolved", () => {
    expect(definitionHash(resolveScoreDefinition(assertion(RULE).definition))).toBe(
      definitionHash(resolveScoreDefinition(predicateScorer(RULE).definition)),
    );
  });

  it("refuses a rule only a hosted run could satisfy", () => {
    // Accepting it would fail every iteration with "no render observations",
    // and the author could not tell that from a real regression.
    expect(() => assertion({ type: "widgetRendered" })).toThrow(
      /hosted run captures/,
    );
  });

  it("carries its rule and its kind for a caller that groups by them", () => {
    const built = assertion(RULE);
    expect(built.kind).toBe("assertion");
    expect(built.rule).toEqual(RULE);
  });
});

describe("judge() is judgeScorer() under its canonical name", () => {
  it("builds a byte-identical definition", () => {
    expect(judge(JUDGE_OPTIONS).definition).toEqual(
      judgeScorer(JUDGE_OPTIONS).definition,
    );
  });

  it("keeps the same implementation hash, prompt template included", () => {
    expect(judge(JUDGE_OPTIONS).definition.implementationHash).toBe(
      judgeScorer(JUDGE_OPTIONS).definition.implementationHash,
    );
  });

  it("inherits the constructor's validation rather than restating it", () => {
    expect(() =>
      judge({ ...JUDGE_OPTIONS, prompt: "grade it" } as never),
    ).toThrow(/exactly one of/);
    expect(() => judge({ ...JUDGE_OPTIONS, threshold: 4 })).toThrow(/\[0,1\]/);
  });

  it("is a judge, and an assertion is not", () => {
    expect(judge(JUDGE_OPTIONS).kind).toBe("judge");
    expect(judge(JUDGE_OPTIONS).definition.deterministic).toBe(false);
  });
});

describe("runEvaluators takes either vocabulary", () => {
  it("runs a canonical evaluator and a legacy scorer in one list", async () => {
    const scores = await runEvaluators(
      [assertion(RULE), predicateScorer({ type: "finalAssistantMessageNonEmpty" })],
      context("your refund is on its way"),
    );

    expect(scores).toHaveLength(2);
    // Authored order, regardless of completion order, so a dashboard renders
    // the same list every time.
    expect(scores[0]!.scorerId).toContain("responseContains");
    expect(scores.every((score) => score.status === "scored")).toBe(true);
    expect(scores.every((score) => score.passed === true)).toBe(true);
  });

  it("produces the same rows whichever spelling authored them", async () => {
    const canonical = await runEvaluators([assertion(RULE)], context("refund"));
    const legacy = await runEvaluators([predicateScorer(RULE)], context("refund"));
    expect(canonical).toEqual(legacy);
  });

  it("lands a thrown evaluator as an error row, never as a low score", async () => {
    const exploding = {
      ...assertion(RULE),
      evaluate() {
        throw new Error("boom");
      },
    };

    const [row] = await runEvaluators([exploding], context("refund"));
    // A 0 would say the server did the wrong thing. An error says we could not
    // tell, and the gate decides what that means by reading `onError`.
    expect(row!.status).toBe("error");
    expect(row).not.toHaveProperty("value");
  });

  it("projects the same run into canonical results on request", async () => {
    const scores = await runEvaluators([assertion(RULE)], context("refund"));
    const projected = await runEvaluatorsProjected(
      [assertion(RULE)],
      context("refund"),
    );

    expect(projected[0]!.evaluatorId).toBe(scores[0]!.scorerId);
    expect(projected[0]!.score).toBe(scores[0]!.value);
    expect(projected[0]!.kind).toBe("assertion");
  });

  it("decides the gate from the definitions, not the rows", async () => {
    const evaluator = assertion(RULE);
    const definitions = buildEvaluationConfigSnapshot([
      evaluator.definition,
    ]).definitions;

    const passing = await runEvaluators([evaluator], context("refund issued"));
    const failing = await runEvaluators([evaluator], context("nothing here"));

    expect(evaluatorsPassed(passing, definitions)).toBe(true);
    expect(evaluatorsPassed(failing, definitions)).toBe(false);
  });
});
