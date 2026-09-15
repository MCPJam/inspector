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
import { assertion } from "../src/evaluators/assertion.js";
import {
  authoredRequiredRole,
  capabilityAcceptsCanonicalRole,
  definitionsForDeployment,
  roleForDeployment,
} from "../src/contract/policy-spelling.js";
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
 * differ, and the gate has to pin both — otherwise a later constructor could
 * reuse the implementation hash as the id and renumber every policy-bearing
 * anonymous evaluator without failing here.
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

  "anonymous assertion through scorers — the content-derived id": () =>
    new EvalTest({
      id: "c_anonymous",
      name: "anonymous",
      test: passing,
      scorers: [predicateScorer({ type: "responseContains", needle: "refund" })],
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
      goldenCases.map((entry) => entry.label).sort(),
    );
  });

  for (const entry of goldenCases) {
    describe(entry.label, () => {
      it("produces the pinned snapshot", () => {
        const built = legacyBuilders[entry.label]!().getEvaluationConfigSnapshot();
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
            built.definitions.map((d) => [d.scorerId, definitionHash(d)]),
          ),
        ).toEqual(entry.definitionHashes);
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

  it("refuses a reserved id before the builder can collapse anything", () => {
    // The distinction the contract now spells out. Identical content collapses
    // — but only OUTSIDE the reserved set, and this is the case a reader would
    // otherwise get wrong: a built-in row minted against the wrong definition
    // carries a hash that joins to nothing, and the gate's fail-closed join
    // reads an unjoinable row as tampering.
    expect(
      () =>
        new EvalTest({
          id: "c_reserved",
          name: "reserved",
          test: passing,
          scorers: [
            predicateScorer({ type: "noToolErrors" }, { id: "tool-match" }),
          ],
        }).getEvaluationConfigSnapshot(),
    ).toThrow(/already used by this test's built-in scorers/);
  });

  it("refuses one id standing for two different evaluations", () => {
    expect(
      () =>
        new EvalTest({
          id: "c_conflict",
          name: "conflict",
          test: passing,
          scorers: [
            predicateScorer({ type: "noToolErrors" }, { id: "same" }),
            predicateScorer(
              { type: "finalAssistantMessageNonEmpty" },
              { id: "same" },
            ),
          ],
        }).getEvaluationConfigSnapshot(),
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
      snapshot.definitions.filter((d) => d.scorerId === "same"),
    ).toHaveLength(1);
  });

  it("pins the content-derived id of an anonymous assertion", () => {
    const row = goldenCases.find(
      (entry) =>
        entry.label ===
        "anonymous assertion through scorers — the content-derived id",
    )!;
    const generated = row.snapshot.definitions.find(
      (definition) => definition.idSource === "generated",
    )!;

    // A standalone evaluator has no position, so its id comes from its rule's
    // content — the whole digest, because two rules sharing a truncated one
    // would mint a single id for two definitions. Nothing else in this corpus
    // covers that path: the `predicates` rows are positional and the other
    // scorer row is explicitly named.
    expect(generated.scorerId).toMatch(
      /^predicate:responseContains#[0-9a-f]{64}$/,
    );
    // Equal HERE only because this rule carries no policy fields. The row
    // below is the general case, where the two diverge.
    expect(generated.implementationHash).toBe(
      generated.scorerId.split("#")[1],
    );
  });

  it("pins an anonymous assertion whose rule carries policy", () => {
    const row = goldenCases.find((entry) => entry.label === POLICY_LABEL)!;
    const generated = row.snapshot.definitions.find(
      (definition) => definition.idSource === "generated",
    )!;

    // The id digests the whole rule; the implementation hash digests it with
    // `role` and `severity` stripped. Note that the implementation hash is the
    // POLICY-FREE rule's id suffix, which is why asserting the two are equal
    // in general would have frozen the wrong rule.
    expect(generated.scorerId).toBe(
      "predicate:responseContains#f54cf792125b3846651c875cae4d417bb1adf5d6dab0992cca5f661142c6d779",
    );
    expect(generated.implementationHash).toBe(
      "1ed825dd8c4484fa231d4b04177afae713ed9ab60de848091d076ea2af8d00e1",
    );
    expect(generated.implementationHash).not.toBe(
      generated.scorerId.split("#")[1],
    );
    expect(generated.role).toBe("advisory");
  });

  it("pins a real judge's rubric-and-template hash", () => {
    const row = goldenCases.find((entry) =>
      entry.label.startsWith("a real judge"),
    )!;
    const judge = row.snapshot.definitions.find(
      (definition) => definition.deterministic === false,
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

/**
 * The rename costs no identity.
 *
 * This is the load-bearing claim of the whole `required` / `advisory` change,
 * and the one that is expensive to be wrong about: every stored score row
 * joins to its definition by `definitionHash`, and every `eval gate
 * --baseline <run>` resolves its scorer set the same way. If renaming the word
 * moved a digest, every historical run would silently stop joining and every
 * baseline would report a scorer set replaced wholesale — with green tests,
 * because both sides of a rehash agree with each other.
 *
 * Two mechanisms keep it still, and they are not the same mechanism:
 *
 *   - `hashSpelling` freezes the role INSIDE the hash payload at `"gating"`,
 *     so a definition's digest does not depend on which word it carries.
 *   - `canonicalizeCheckRole` maps an authored `"required"` to the ABSENT
 *     field before a rule is digested for an anonymous id — the form Gate has
 *     always been written in, and the form the UI writes when an author picks
 *     Required.
 *
 * An explicit `role: "gating"` on a rule keeps its OWN existing id,
 * deliberately: that identity is already minted in the field, and folding it
 * into the bare form would rotate exactly the ids this change promises not to
 * touch. `required` joins the bare form because that is the same authored
 * intent expressed in the new word, not because the three are interchangeable.
 */
describe("required is a spelling, not a new evaluator", () => {
  const idOf = (rule: Predicate) => predicateScorer(rule).definition;

  it("mints the BARE rule's identity for an authored `required`", () => {
    const required = idOf({ type: "noToolErrors", role: "required" } as Predicate);
    const bare = idOf({ type: "noToolErrors" } as Predicate);
    expect(required.scorerId).toBe(bare.scorerId);
    expect(required.implementationHash).toBe(bare.implementationHash);
    expect(definitionHash(resolveForHash(required))).toBe(
      definitionHash(resolveForHash(bare)),
    );
    // The spelling this build EMITS, which is now the canonical one. The
    // digest above is identical either way, which is what made flipping it
    // free.
    expect(required.role).toBe(authoredRequiredRole());
  });

  it("leaves an explicit `gating` rule's existing identity exactly where it was", () => {
    // NOT folded into the bare form. That id is already minted in the field;
    // rotating it to tidy up a spelling would orphan every score row that
    // carries it — the precise failure this whole design avoids.
    const legacy = idOf({ type: "noToolErrors", role: "gating" } as Predicate);
    const bare = idOf({ type: "noToolErrors" } as Predicate);
    expect(legacy.scorerId).not.toBe(bare.scorerId);
    // And its definition still resolves to the same effective role, so the two
    // differ in identity only, never in what they do.
    expect(legacy.role).toBe(authoredRequiredRole());
  });

  it("gives `assertion()` one identity for all three spellings", () => {
    // `assertion()` strips policy off the rule before minting, so this is the
    // authoring surface where the three genuinely ARE one id. It is also the
    // surface the docs point an author at.
    const ids = (
      [
        { type: "noToolErrors", role: "required" },
        { type: "noToolErrors", role: "gating" },
        { type: "noToolErrors" },
      ] as Predicate[]
    ).map((rule) => assertion(rule as never).definition);
    for (const built of ids) {
      expect(built.scorerId).toBe(ids[0].scorerId);
      expect(built.implementationHash).toBe(ids[0].implementationHash);
      expect(definitionHash(resolveForHash(built))).toBe(
        definitionHash(resolveForHash(ids[0])),
      );
    }
    // And the rule it carries is in the storage spelling, because `EvalTest`
    // uploads this object per iteration.
    expect(assertion({ type: "noToolErrors", role: "required" } as never).rule)
      .toEqual({ type: "noToolErrors" });
  });

  it("keeps advisory a different tier — this collapses a spelling, not a tier", () => {
    const required = assertion({
      type: "noToolErrors",
      role: "required",
    } as never).definition;
    const advisory = assertion({
      type: "noToolErrors",
      role: "advisory",
    } as never).definition;
    expect(advisory.role).toBe("advisory");
    expect(definitionHash(resolveForHash(advisory))).not.toBe(
      definitionHash(resolveForHash(required)),
    );
    // Same rule, though: policy is stripped from identity, so flipping the
    // tier must not renumber score rows or read as a different scorer.
    expect(advisory.scorerId).toBe(required.scorerId);
    expect(advisory.implementationHash).toBe(required.implementationHash);
  });

  it("gives a judge authored `required` the same definition as one authored `gating`", () => {
    const build = (role: "required" | "gating") =>
      judgeScorer({
        id: "policy-grounding",
        model: "anthropic/claude-sonnet-4-6",
        apiKey: "test",
        rubric: ["The answer is supported by the retrieved policy."],
        role,
      }).definition;
    expect(build("required")).toEqual(build("gating"));
  });

  it("hashes an explicitly required definition exactly like its gating twin", () => {
    // Straight at the payload, bypassing the builders: this is the property
    // `hashSpelling` exists for, asserted with nothing in between.
    const base = {
      scorerId: "refund-mentioned",
      idSource: "explicit" as const,
      scorerVersion: "1",
      implementationHash: "impl-refund-predicate-v1",
      deterministic: true,
      passThreshold: 1,
      onError: "fail" as const,
      onSkipped: "fail" as const,
    };
    expect(definitionHash({ ...base, role: "required" })).toBe(
      definitionHash({ ...base, role: "gating" }),
    );
    expect(definitionHash({ ...base, role: "advisory" })).not.toBe(
      definitionHash({ ...base, role: "gating" }),
    );
  });
});

/**
 * The capability gate on EMITTING the canonical spelling.
 *
 * The two repositories deploy independently and "merged" is not "deployed", so
 * an SDK that emits `required` may be talking to a backend whose
 * `validateScorePayload` still refuses it. That failure is the expensive one:
 * every iteration of the run is quarantined `score_integrity_invalid`, and the
 * dashboard then looks EMPTY rather than broken — the run appears to have
 * produced no evidence at all, and nothing says why.
 */
describe("emitting the canonical spelling is gated on the deployment", () => {
  const WITH_CAPABILITY = { vocabulary: { values: { role: ["gating"] } } };

  it("reads the capability VALUE, never the presence of a field beside it", () => {
    expect(capabilityAcceptsCanonicalRole(WITH_CAPABILITY)).toBe(true);
    // `vocabulary` without `values.role` is a deployment that speaks the field
    // vocabulary and not this value — exactly the case a version check or a
    // "does it have `vocabulary`?" test would get wrong.
    expect(
      capabilityAcceptsCanonicalRole({ vocabulary: { version: 2, fields: {} } }),
    ).toBe(false);
    expect(capabilityAcceptsCanonicalRole(undefined)).toBe(false);
    expect(capabilityAcceptsCanonicalRole({})).toBe(false);
    expect(capabilityAcceptsCanonicalRole(null)).toBe(false);
  });

  it("falls back to the legacy spelling against a deployment that does not advertise it", () => {
    expect(roleForDeployment("required", WITH_CAPABILITY)).toBe("required");
    expect(roleForDeployment("required", undefined)).toBe("gating");
    // Advisory is one word in both vocabularies and never moves.
    expect(roleForDeployment("advisory", undefined)).toBe("advisory");
    expect(roleForDeployment("advisory", WITH_CAPABILITY)).toBe("advisory");
  });

  it("is hash-neutral, which is what makes the fallback safe", () => {
    // Downgrading on the way out must not change any identity, or a run
    // against an older backend would file its rows under different digests
    // than the same run against a newer one.
    const definition = {
      scorerId: "refund-mentioned",
      idSource: "explicit" as const,
      scorerVersion: "1",
      implementationHash: "impl-refund-predicate-v1",
      deterministic: true,
      passThreshold: 1,
      role: "required" as const,
      onError: "fail" as const,
      onSkipped: "fail" as const,
    };
    const [downgraded] = definitionsForDeployment([definition], undefined);
    expect(downgraded.role).toBe("gating");
    expect(definitionHash(downgraded)).toBe(definitionHash(definition));
  });

  it("leaves the list uncopied when nothing moves", () => {
    const definitions = [
      {
        scorerId: "a",
        idSource: "explicit" as const,
        scorerVersion: "1",
        implementationHash: "h",
        deterministic: true,
        passThreshold: 1,
        role: "advisory" as const,
        onError: "ignore" as const,
        onSkipped: "ignore" as const,
      },
    ];
    expect(definitionsForDeployment(definitions, WITH_CAPABILITY)).toBe(
      definitions,
    );
    expect(definitionsForDeployment(definitions, undefined)).toBe(definitions);
  });
});

/** Fill the two policy defaults `definitionHash` requires, as ingest does. */
function resolveForHash(definition: {
  role: string;
  onError?: "fail" | "ignore";
  onSkipped?: "fail" | "ignore";
}) {
  const fallback = definition.role === "advisory" ? "ignore" : "fail";
  return {
    ...definition,
    onError: definition.onError ?? fallback,
    onSkipped: definition.onSkipped ?? fallback,
  } as Parameters<typeof definitionHash>[0];
}
