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
import { judgeScorer, predicateScorer } from "../src/scorers/index.js";
import { definitionHash } from "../src/contract/derive.js";
import type { EvaluationConfigSnapshot } from "../src/contract/types.js";
import type { Predicate } from "../src/predicates/types.js";
import type { Scorer } from "../src/scorers/types.js";

type GoldenCase = {
  label: string;
  snapshot: EvaluationConfigSnapshot;
  definitionHashes: Record<string, string>;
};
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

/**
 * A REAL judge, not a stand-in.
 *
 * `customEvaluator` above carries a fixed `implementationHash` on purpose — it
 * pins the wiring without pinning a prompt digest. But that left the gate with
 * a hole a reviewer found: no row exercised `judgeScorer`'s actual derivation,
 * so a later `judge()` constructor could change the prompt template version or
 * the hash payload and this suite would stay green while every existing judge's
 * configuration identity moved underneath it.
 *
 * The key is deliberately not a real one. `judgeScorer` builds its provider at
 * construction but does not authenticate, and the definition it produces is a
 * function of the rubric, the template version and the model string — none of
 * which needs a live credential.
 */
const JUDGE_OPTIONS = {
  id: "policy-grounding",
  model: "anthropic/claude-sonnet-4-6",
  apiKey: "sk-test-not-a-real-key",
  rubric: ["The answer is supported by the retrieved policy."],
} as const;

/**
 * The same rule, carrying policy.
 *
 * Its id digests the WHOLE rule, `role` and `severity` included, while its
 * `implementationHash` digests the rule with those stripped. The two therefore
 * differ, and the gate has to pin both or a later constructor could reuse the
 * implementation hash as the id and renumber every policy-bearing anonymous
 * evaluator without failing here.
 */
const policyBearing: Predicate = {
  type: "responseContains",
  needle: "refund",
  role: "advisory",
  severity: "warn",
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
const POLICY_LABEL =
  "anonymous assertion carrying policy — the id keeps it, the implementation hash does not";

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
          { id: "nonempty-answer" }
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

  "anonymous assertion through scorers — the content-derived id": () =>
    new EvalTest({
      id: "c_anonymous",
      name: "anonymous",
      test: passing,
      scorers: [
        predicateScorer({ type: "responseContains", needle: "refund" }),
      ],
    }),

  [POLICY_LABEL]: () =>
    new EvalTest({
      id: "c_anonymous_policy",
      name: "anonymous policy",
      test: passing,
      scorers: [predicateScorer(policyBearing)],
    }),

  "a real judge — the rubric-and-template implementation hash": () =>
    new EvalTest({
      id: "c_judge",
      name: "judge",
      test: passing,
      scorers: [judgeScorer(JUDGE_OPTIONS)],
    }),
};

describe("evaluation config identity is frozen", () => {
  it("covers every golden row with a builder, and every builder with a row", () => {
    expect(Object.keys(legacyBuilders).sort()).toEqual(
      goldenCases.map((entry) => entry.label).sort()
    );
  });

  for (const entry of goldenCases) {
    describe(entry.label, () => {
      it("produces the pinned snapshot", () => {
        const built =
          legacyBuilders[entry.label]!().getEvaluationConfigSnapshot();
        expect(built).toEqual(entry.snapshot);
      });

      it("pins each evaluator's definition hash", () => {
        // The snapshot carries no `definitionHash`, and the aggregate hash is
        // computed separately, so without this a change to `definitionHash()`
        // alone would keep every other assertion green while breaking the
        // `ScoreResult.definitionHash` joins this contract freezes.
        const built =
          legacyBuilders[entry.label]!().getEvaluationConfigSnapshot();
        expect(
          Object.fromEntries(
            built.definitions.map((d) => [d.scorerId, definitionHash(d)])
          )
        ).toEqual(entry.definitionHashes);
      });

      it("keeps every evaluator id and id source, in order", () => {
        const built =
          legacyBuilders[entry.label]!().getEvaluationConfigSnapshot();
        expect(
          built.definitions.map((d) => `${d.scorerId} (${d.idSource})`)
        ).toEqual(
          entry.snapshot.definitions.map((d) => `${d.scorerId} (${d.idSource})`)
        );
      });
    });
  }

  it("refuses a reserved id before the builder can collapse anything", () => {
    // The distinction the contract now spells out. Identical content collapses
    // — but only OUTSIDE the reserved set, and this is the case a reader would
    // otherwise get wrong: a built-in row minted against the wrong definition
    // carries a hash that joins to nothing, and the gate's fail-closed join
    // reads an unjoinable row as tampering.
    expect(() =>
      new EvalTest({
        id: "c_reserved",
        name: "reserved",
        test: passing,
        scorers: [
          predicateScorer({ type: "noToolErrors" }, { id: "tool-match" }),
        ],
      }).getEvaluationConfigSnapshot()
    ).toThrow(/already used by this test's built-in scorers/);
  });

  it("refuses one id standing for two different evaluations", () => {
    expect(() =>
      new EvalTest({
        id: "c_conflict",
        name: "conflict",
        test: passing,
        scorers: [
          predicateScorer({ type: "noToolErrors" }, { id: "same" }),
          predicateScorer(
            { type: "finalAssistantMessageNonEmpty" },
            { id: "same" }
          ),
        ],
      }).getEvaluationConfigSnapshot()
    ).toThrow();
  });

  it("collapses one id standing for one evaluation, named twice", () => {
    const snapshot = new EvalTest({
      id: "c_collapse",
      name: "collapse",
      test: passing,
      scorers: [
        predicateScorer({ type: "noToolErrors" }, { id: "same" }),
        predicateScorer({ type: "noToolErrors" }, { id: "same" }),
      ],
    }).getEvaluationConfigSnapshot();

    expect(
      snapshot.definitions.filter((d) => d.scorerId === "same")
    ).toHaveLength(1);
  });

  it("pins the content-derived id of an anonymous assertion", () => {
    const row = goldenCases.find(
      (entry) =>
        entry.label ===
        "anonymous assertion through scorers — the content-derived id"
    )!;
    const generated = row.snapshot.definitions.find(
      (definition) => definition.idSource === "generated"
    )!;

    // A standalone evaluator has no position, so its id comes from its rule's
    // content — the whole digest, because two rules sharing a truncated one
    // would mint a single id for two definitions. Nothing else in this corpus
    // covers that path: the `predicates` rows are positional and the other
    // scorer row is explicitly named.
    expect(generated.scorerId).toMatch(
      /^predicate:responseContains#[0-9a-f]{64}$/
    );
    // Equal HERE only because this rule carries no policy fields. The row
    // below is the general case, where they diverge.
    expect(generated.implementationHash).toBe(generated.scorerId.split("#")[1]);
  });

  it("pins an anonymous assertion whose rule carries policy", () => {
    const row = goldenCases.find((entry) => entry.label === POLICY_LABEL)!;
    const generated = row.snapshot.definitions.find(
      (definition) => definition.idSource === "generated"
    )!;

    // The id digests the whole rule; the implementation hash digests it with
    // `role` and `severity` stripped. Note the implementation hash is the
    // POLICY-FREE rule's id suffix, which is why asserting the two are equal
    // in general would have frozen the wrong rule.
    expect(generated.scorerId).toBe(
      "predicate:responseContains#f54cf792125b3846651c875cae4d417bb1adf5d6dab0992cca5f661142c6d779"
    );
    expect(generated.implementationHash).toBe(
      "1ed825dd8c4484fa231d4b04177afae713ed9ab60de848091d076ea2af8d00e1"
    );
    expect(generated.implementationHash).not.toBe(
      generated.scorerId.split("#")[1]
    );
    expect(generated.role).toBe("advisory");
  });

  it("pins a real judge's rubric-and-template hash", () => {
    const row = goldenCases.find((entry) =>
      entry.label.startsWith("a real judge")
    )!;
    const judge = row.snapshot.definitions.find(
      (definition) => definition.deterministic === false
    )!;

    // Derived by `judgeScorer` from the rubric, the prompt TEMPLATE VERSION and
    // the model. Pinning it is what stops a later constructor from moving the
    // template while every judge's configuration identity moves with it and
    // this gate stays green.
    expect(judge.scorerId).toBe("policy-grounding");
    expect(judge.idSource).toBe("explicit");
    expect(judge.passThreshold).toBe(0.7);
    expect(judge.role).toBe("advisory");
    expect(judge.implementationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the generated ids that a later rule insertion would renumber", () => {
    const renumberable = goldenCases
      .flatMap((entry) => entry.snapshot.definitions)
      .filter((definition) => definition.idSource === "generated")
      .map((definition) => definition.scorerId);
    // Not an incidental list: these are the ids that are positional by
    // construction, and the reason a gate refuses to select one.
    // Positional ones first, then the anonymous content-derived id, which is
    // `generated` for a different reason: content-stable is not author-stable
    // either, so a gate must not select it.
    expect(renumberable).toEqual([
      "predicate:responseContains#0",
      "predicate:responseContains#1",
      "predicate:noToolErrors#0",
      "predicate:responseContains#0",
      "predicate:responseContains#1ed825dd8c4484fa231d4b04177afae713ed9ab60de848091d076ea2af8d00e1",
      "predicate:responseContains#f54cf792125b3846651c875cae4d417bb1adf5d6dab0992cca5f661142c6d779",
    ]);
  });
});
