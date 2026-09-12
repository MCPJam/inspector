/**
 * The equivalence gate for the evaluator-vocabulary program.
 *
 * `sdk/tests/fixtures/evaluator-vocabulary-golden.json` holds the
 * `EvaluationConfigSnapshot` each authored case produced BEFORE any of the
 * vocabulary work, captured from unchanged code. Every later step — the
 * canonical result projection, the `assertion()` / `judge()` constructors, the
 * `evaluators` list, `execute` in place of `test` — must keep producing these
 * exact snapshots.
 *
 * WHY IT ASSERTS IDS LITERALLY AS WELL AS DEEP-EQUALITY. The aggregate `hash`
 * sorts its inputs, so two configurations whose definitions were renumbered
 * against each other could in principle agree on it while disagreeing about
 * which rule is `#0`. A generated id is positional and documented as unstable
 * precisely because inserting a rule above it renumbers it — so the ids are the
 * thing a later reader joins on, and they get their own assertion.
 *
 * NEVER regenerate the fixture to make a change pass. A green test bought by
 * editing both the producer and the expected payload proves nothing at all. If
 * a change here is genuinely intended, it is an identity change: it resets
 * baseline comparability for every existing suite and belongs in its own PR
 * with that consequence stated.
 */

import { describe, expect, it } from "vitest";
import golden from "./fixtures/evaluator-vocabulary-golden.json" with { type: "json" };
import { EvalTest } from "../src/EvalTest.js";
import { predicateScorer } from "../src/scorers/index.js";
import type { EvaluationConfigSnapshot } from "../src/contract/types.js";
import type { Predicate } from "../src/predicates/types.js";
import type { Scorer } from "../src/scorers/types.js";

type GoldenCase = { label: string; snapshot: EvaluationConfigSnapshot };
const goldenCases = (golden as unknown as { cases: GoldenCase[] }).cases;

const passing = async () => true;

/**
 * A custom non-deterministic evaluator with a FIXED `implementationHash`.
 *
 * Fixed rather than derived so the fixture pins the wiring — where the
 * definition lands in the order, what id it keeps — without also pinning the
 * digest of whatever prompt a real judge would carry.
 */
const customEvaluator: Scorer = {
  definition: {
    scorerId: "custom:tone",
    idSource: "explicit",
    scorerVersion: "1",
    implementationHash: "fixedhash-tone-v1",
    label: "tone",
    deterministic: false,
    passThreshold: 0.7,
    role: "advisory",
    model: "anthropic/claude-sonnet-4-6",
  },
  score() {
    return { kind: "scored" as const, value: 1 };
  },
};

const twoSameType: Predicate[] = [
  { type: "responseContains", needle: "refund" },
  { type: "responseContains", needle: "policy" },
];

/**
 * The legacy authoring of each golden case, keyed by the fixture's label.
 *
 * Later steps add a canonical builder beside each of these and assert both
 * against the same row — which is what makes "the new facade is the same
 * evaluation" a claim the suite checks rather than a claim the PR body makes.
 */
const legacyBuilders: Record<string, () => EvalTest> = {
  "bare test — no expectations, no assertions": () =>
    new EvalTest({ id: "c_bare", name: "bare", test: passing }),

  "two assertions of the same type — positional ordinals must differ": () =>
    new EvalTest({
      id: "c_two_same_type",
      name: "two same type",
      test: passing,
      predicates: twoSameType,
    }),

  "assertions plus a custom advisory evaluator": () =>
    new EvalTest({
      id: "c_mixed",
      name: "mixed",
      test: passing,
      predicates: [{ type: "noToolErrors" }],
      scorers: [customEvaluator],
    }),

  "negative case with no expectations — tool-match is applicable and gating":
    () =>
      new EvalTest({
        id: "c_negative",
        name: "negative",
        test: passing,
        isNegativeTest: true,
      }),

  "explicit-id assertion through scorers": () =>
    new EvalTest({
      id: "c_explicit_id",
      name: "explicit id",
      test: passing,
      scorers: [
        predicateScorer(
          { type: "finalAssistantMessageNonEmpty" },
          { id: "nonempty-answer" },
        ),
      ],
    }),

  "expectations plus assertions — full definition order": () =>
    new EvalTest({
      id: "c_full",
      name: "full",
      test: passing,
      expectedToolCalls: [{ toolName: "search_policies", arguments: {} }],
      predicates: [{ type: "responseContains", needle: "refund" }],
      scorers: [customEvaluator],
    }),
};

describe("evaluation config identity is frozen", () => {
  it("covers every golden row with a builder, and every builder with a row", () => {
    expect(Object.keys(legacyBuilders).sort()).toEqual(
      goldenCases.map((entry) => entry.label).sort(),
    );
  });

  for (const entry of goldenCases) {
    describe(entry.label, () => {
      it("produces the pinned snapshot", () => {
        const built = legacyBuilders[entry.label]!().getEvaluationConfigSnapshot();
        expect(built).toEqual(entry.snapshot);
      });

      it("keeps every evaluator id and id source, in order", () => {
        const built = legacyBuilders[entry.label]!().getEvaluationConfigSnapshot();
        expect(
          built.definitions.map((d) => `${d.scorerId} (${d.idSource})`),
        ).toEqual(
          entry.snapshot.definitions.map(
            (d) => `${d.scorerId} (${d.idSource})`,
          ),
        );
      });
    });
  }

  it("pins the generated ids that a later rule insertion would renumber", () => {
    const renumberable = goldenCases
      .flatMap((entry) => entry.snapshot.definitions)
      .filter((definition) => definition.idSource === "generated")
      .map((definition) => definition.scorerId);
    // Not an incidental list: these are the ids that are positional by
    // construction, and the reason a gate refuses to select one.
    expect(renumberable).toEqual([
      "predicate:responseContains#0",
      "predicate:responseContains#1",
      "predicate:noToolErrors#0",
      "predicate:responseContains#0",
    ]);
  });
});
