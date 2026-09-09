import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { allGatingScorersPassed, definitionHash } from "@mcpjam/sdk/contract";
import { buildIterationFinishParams } from "../finalize-iteration.js";
import { buildHostedScoreContract } from "../score-rows.js";
import { hostedCriterionId } from "../score-definitions.js";
import { resetShadowMismatchStateForTests } from "../shadow-mismatch.js";
import { logger } from "../../../utils/logger.js";

// =============================================================================
// THE REPLACEMENT PIN for `iteration-verdict-pinned.test.ts`.
//
// B3a pinned "`passed` is the sole authority, in every grading mode". B3b makes
// the versioned score contract authoritative at `enforce`, so that claim is now
// scoped to the modes below it — and this file is what takes its place. It
// ships in the SAME diff as the amendment, because a pin weakened in one PR and
// replaced in another is a pin that was deleted with a promise attached.
//
// What it pins: at `enforce`, an iteration's outgoing result is EXACTLY the
// shared derivation over its gating rows — the SDK contract's
// `allGatingScorersPassed`, the same function the backend re-derives with when
// it verifies. Asserted against that function rather than against hand-written
// booleans, so the two ends of the wire cannot drift apart while both stay
// green: if the arithmetic changes, this file changes with it, and the shared
// parity fixtures are what pin the arithmetic itself.
//
// The corpus deliberately includes error, skipped, advisory and no-gating-rows
// cases — the shapes where "derived from the rows" and "whatever the boolean
// pipeline said" come apart.
// =============================================================================

const ENV_KEY = "MCPJAM_GRADING_ENGINE_MODE";
const originalEnv = process.env[ENV_KEY];

const usageZero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

const passingPredicate = {
  type: "tool_called",
  toolName: "list_files",
} as unknown as Predicate;
const failingPredicate = {
  type: "tool_called",
  toolName: "delete_everything",
} as unknown as Predicate;

/** A matcher verdict shaped the way the runner hands one over. */
function evaluationFor(passed: boolean) {
  return {
    passed,
    toolsCalled: ["list_files"],
    turnCount: 1,
    failedTurnCount: 0,
    expectedToolCalls: ["list_files"],
    missing: passed ? [] : ["list_files"],
    unexpected: [],
    argumentMismatches: [],
  };
}

function build(over: Record<string, unknown> = {}) {
  return buildIterationFinishParams({
    iterationId: "iter1",
    runId: "run1",
    passed: true,
    evaluation: evaluationFor(true),
    usage: usageZero,
    messages,
    status: "completed",
    startedAt: 0,
    iterationMetadataBase: {},
    gradingMode: "enforce",
    ...over,
  } as unknown as Parameters<typeof buildIterationFinishParams>[0]);
}

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  resetShadowMismatchStateForTests();
  vi.restoreAllMocks();
});

// One entry per shape the derivation has to get right. `reportedPassed` is what
// the BOOLEAN pipeline said; the assertion is that the outgoing result follows
// the ROWS, and that the rows and the boolean agree wherever they honestly can.
const CORPUS: Array<{
  label: string;
  why?: string;
  reportedPassed: boolean;
  predicateResults?: Array<{ predicate: Predicate; passed: boolean }>;
  evaluationPassed: boolean;
  isNegativeTest?: boolean;
}> = [
  {
    label: "every gating scorer passed",
    reportedPassed: true,
    predicateResults: [{ predicate: passingPredicate, passed: true }],
    evaluationPassed: true,
  },
  {
    label: "a gating predicate failed",
    reportedPassed: false,
    predicateResults: [{ predicate: failingPredicate, passed: false }],
    evaluationPassed: true,
  },
  {
    label: "the tool-call matcher failed",
    reportedPassed: false,
    predicateResults: [{ predicate: passingPredicate, passed: true }],
    evaluationPassed: false,
  },
  {
    label: "both a predicate and the matcher failed",
    reportedPassed: false,
    predicateResults: [{ predicate: failingPredicate, passed: false }],
    evaluationPassed: false,
  },
  {
    label: "a negative-test case with no expectations",
    why: "polarity rides on the toolCalls:match definition hash, not on the arithmetic",
    reportedPassed: true,
    evaluationPassed: true,
    isNegativeTest: true,
  },
  {
    label: "several predicates, one of them failing",
    reportedPassed: false,
    predicateResults: [
      { predicate: passingPredicate, passed: true },
      { predicate: failingPredicate, passed: false },
    ],
    evaluationPassed: true,
  },
];

describe("at enforce, the result IS the shared derivation over the gating rows", () => {
  for (const entry of CORPUS) {
    test(entry.label, () => {
      const params = build({
        passed: entry.reportedPassed,
        evaluation: evaluationFor(entry.evaluationPassed),
        ...(entry.predicateResults
          ? { predicateResults: entry.predicateResults }
          : {}),
        ...(entry.isNegativeTest ? { isNegativeTest: true } : {}),
      });
      const metadata = params.metadata as Record<string, unknown>;

      // The rows that were actually persisted, re-read through the SAME
      // function the backend verifies with. Recomputing the expectation from a
      // second source is what would let the two drift while both stayed green.
      const expected = allGatingScorersPassed(
        metadata.scores as never,
        metadata.evaluationConfig as never
      );
      // Conjunction, not replacement — see below.
      expect(params.passed).toBe(entry.reportedPassed && expected.passed);
    });
  }

  test("the persisted keys are the same ones dual_write writes", () => {
    // This is what makes `enforce → dual_write` a flag flip with no migration
    // in either direction: the two modes differ in who DECIDES, not in what
    // lands. If this ever stops holding, the rollback stops being free.
    const enforced = build({
      predicateResults: [{ predicate: passingPredicate, passed: true }],
    });
    const dualWrite = build({
      gradingMode: "dual_write",
      predicateResults: [{ predicate: passingPredicate, passed: true }],
    });

    expect(Object.keys(enforced.metadata as object).sort()).toEqual(
      Object.keys(dualWrite.metadata as object).sort()
    );
    expect((enforced.metadata as Record<string, unknown>).scores).toEqual(
      (dualWrite.metadata as Record<string, unknown>).scores
    );
  });

  test("an unscorable gating row fails the iteration — zero evidence never passes", () => {
    // Hand-built rather than produced by the runner, because the first pass
    // cannot currently emit a gating `error` row (predicates and the matcher
    // always resolve to a boolean). The arithmetic still has to be right for
    // the day a gating scorer CAN break — that is the H9 pin, and it is the
    // case where "derived" and "reported" would otherwise come apart in the
    // dangerous direction.
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults: [{ predicate: passingPredicate, passed: true }],
      evaluation: evaluationFor(true),
    });
    const broken = scores.map((row, index) =>
      index === 0
        ? {
            ...row,
            status: "error" as const,
            value: undefined,
            passed: undefined,
            error: "scorer threw",
          }
        : row
    );

    const derived = allGatingScorersPassed(broken, evaluationConfig);
    expect(derived.passed).toBe(false);
    expect(derived.unresolvedScorerIds.length).toBeGreaterThan(0);
    // Reported as an ABSENCE, not a disagreement — which is what keeps it out
    // of the shadow comparison and routes it to the evaluator-error path.
    expect(derived.disagreeingScorerIds).toEqual([]);
  });

  test("an advisory row cannot change the result", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults: [{ predicate: passingPredicate, passed: true }],
      evaluation: evaluationFor(true),
      judgeVerdict: {
        score: 0,
        threshold: 0.7,
        status: "completed",
        verdict: "fail",
      },
    });

    expect(allGatingScorersPassed(scores, evaluationConfig).passed).toBe(true);
  });

  test("a case with no gating rows keeps the boolean verdict", () => {
    // Nothing to derive FROM. Returning a derived verdict here would fail every
    // iteration whose case authored no gating criteria; the backend's verify
    // seam independently reaches the same conclusion (`not_derivable`).
    const params = build({
      passed: true,
      // No authored expectations and no predicates ⇒ no gating scorer exists.
      evaluation: {
        passed: true,
        toolsCalled: [],
        turnCount: 1,
        failedTurnCount: 0,
        expectedToolCalls: [],
        missing: [],
        unexpected: [],
        argumentMismatches: [],
      },
    });
    expect((params.metadata as Record<string, unknown>).scores).toBeUndefined();
    expect(params.passed).toBe(true);
  });

  test("agreement emits no mismatch telemetry", () => {
    // Expected ZERO by construction: the rows and the boolean verdict are two
    // projections of ONE evaluation, so a nonzero rate during the enforce soak
    // is a bug signal rather than a finding.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    build({
      passed: false,
      evaluation: evaluationFor(true),
      predicateResults: [{ predicate: failingPredicate, passed: false }],
    });
    const mismatches = warn.mock.calls.filter(
      (call) => call[0] === "grading_shadow_mismatch"
    );
    expect(mismatches).toHaveLength(0);
  });
});

// =============================================================================
// THE ONE DIRECTION THE ROWS MAY MOVE A VERDICT.
//
// The score contract is a projection of the evaluation, and that projection is
// NOT YET TOTAL. `buildEvalIterationVerdict` also gates on `failOnToolError`,
// pinned tool errors, `iterationError` and `scriptedCheckFailures`, and none of
// those produce a gating score row. So an iteration that failed on one of them
// arrives here with an all-passing row set.
//
// Reading the rows as the SOLE authority would turn that failure into a pass —
// the one thing this cutover must never do, and undetectable downstream because
// the backend's verify seam derives from the same incomplete projection and
// would agree. The conjunction is the structural guard, and it comes out when
// those gates are projected as rows.
// =============================================================================
describe("at enforce the rows may only make a verdict stricter", () => {
  test("a legacy-gate failure with all-passing rows STAYS failed", () => {
    // One passing predicate, no authored tool-call expectations ⇒ every gating
    // row passes. The boolean pipeline failed it on a gate the contract cannot
    // see, and that failure must survive.
    const params = build({
      passed: false,
      predicateResults: [{ predicate: passingPredicate, passed: true }],
      evaluation: {
        passed: true,
        toolsCalled: [],
        turnCount: 1,
        failedTurnCount: 0,
        expectedToolCalls: [],
        missing: [],
        unexpected: [],
        argumentMismatches: [],
      },
    });
    const metadata = params.metadata as Record<string, unknown>;

    expect(
      allGatingScorersPassed(
        metadata.scores as never,
        metadata.evaluationConfig as never,
      ).passed,
      "precondition: the rows really do all pass",
    ).toBe(true);
    expect(params.passed).toBe(false);
  });

  test("the rows still FAIL an iteration the boolean pipeline passed", () => {
    // This is what `enforce` adds, and why the conjunction does not make it a
    // no-op: a gating row that failed flips a reported pass to failed.
    const params = build({
      passed: true,
      predicateResults: [{ predicate: failingPredicate, passed: false }],
    });
    expect(params.passed).toBe(false);
  });
});

// =============================================================================
// THE DESIGNED DIVERGENCE — so the soak's "mismatch should be zero" is honest.
//
// Below `enforce`, a shadow mismatch means two projections of one evaluation
// disagreed, which cannot happen honestly, so nonzero is a bug signal. At
// `enforce` that reading is WRONG, and acting on it would make an operator
// treat the feature working as an incident.
//
// The strict reading fails an iteration whose gating evidence is missing or
// unscorable (`unresolvedScorerIds`) where the legacy boolean pipeline passed
// it. That is precisely the safety `enforce` is bought for — zero evidence
// never passes — so it is a designed divergence, not drift.
//
// Pinned here so the claim in `buildScoreMetadata`'s docblock is checkable:
// an enforce mismatch is triage ("which list is populated?"), not an alarm.
// =============================================================================
describe("an unresolved gating row is a strictness catch, not drift", () => {
  /** A gating definition whose row is an `error` under an `onError: fail` policy. */
  function erroredGatingConfig() {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults: [{ predicate: passingPredicate, passed: true }],
      evaluation: evaluationFor(true),
    });
    const gating = evaluationConfig.definitions.find(
      (definition) => definition.role === "gating"
    )!;
    // Replace the row with an honest `error` — the scorer RAN and broke.
    // Matched by `scorerId`: a definition carries no `definitionHash` field
    // (the hash is DERIVED from it), so joining on that would silently match
    // nothing and leave every row passing.
    const errored = scores.map((row) =>
      row.scorerId === gating.scorerId
        ? {
            ...row,
            status: "error" as const,
            error: "scorer threw",
            value: undefined,
            passed: undefined,
          }
        : row
    );
    return { definitions: evaluationConfig, scores: errored, gating };
  }

  test("the derivation reports it as UNRESOLVED, not as a disagreement", () => {
    const { definitions, scores } = erroredGatingConfig();
    const verdict = allGatingScorersPassed(scores, definitions);

    // The distinction the docblock tells an operator to check.
    expect(verdict.passed).toBe(false);
    expect(verdict.disagreeingScorerIds).toEqual([]);
    expect(verdict.unresolvedScorerIds.length).toBeGreaterThan(0);
  });

  test("so legacy PASSED and strict FAILED is a legitimate outcome", () => {
    // The exact shape an operator will see in the soak: the boolean pipeline
    // passed the iteration, the rows could not corroborate it, and the
    // conjunction lands on failed. Nothing here is a bug.
    const { definitions, scores } = erroredGatingConfig();
    const reportedPassed = true;
    const derived = allGatingScorersPassed(scores, definitions);

    expect(reportedPassed).toBe(true);
    expect(derived.passed).toBe(false);
    expect(reportedPassed && derived.passed).toBe(false);
  });
});

// =============================================================================
// THE RUN MUST AGREE WITH ITS OWN ROWS.
//
// `buildIterationFinishParams` returns the DERIVED verdict as `passed`. The
// runners aggregate `evaluation.passed` into `summary.passed`/`failed`/
// `passRate`, and `passCriteria.minimumPassRate` is judged against that rate.
//
// If the runner keeps the boolean verdict there, a strictness catch persists
// `failed` on the iteration while the run counts it a PASS — the pass rate
// inflated by exactly the cases `enforce` exists to catch, and an iteration
// disagreeing with the run that contains it. Both runners therefore re-read
// `finishParams.passed` after the call.
//
// This asserts the property the runners depend on: the returned `passed` IS
// the derived verdict, so assigning it is sufficient.
// =============================================================================
describe("every gating definition this pass builds also gets a scored row", () => {
  // WHY THIS IS THE TEST, and not "an errored row fails the iteration".
  //
  // Review asked for the latter. It cannot be written against this entry point,
  // and finding out why was worth more than the test would have been: the
  // strictness catch is UNREACHABLE from the first pass. Predicates and
  // `toolCalls:match` always produce a `scored` verdict, and the judge is
  // advisory, so no gating definition here can ever be unresolved.
  //
  // So `enforce` is currently a no-op in the failing direction on the hosted
  // first pass, and the soak should expect that rather than read it as the
  // feature being broken. The catch lives where gating rows can carry
  // `error`/`skipped` — SDK-reported runs at the backend's verify seam.
  //
  // Pinned because it is load-bearing in BOTH directions: if a future change
  // makes a gating definition emit no row, or an unscorable one, this fails and
  // the reader learns the first pass has gained a strictness path that needs
  // its own coverage.
  test("no gating definition is left unresolved, so the strict path cannot fire", () => {
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults: [
        { predicate: passingPredicate, passed: true },
        { predicate: failingPredicate, passed: false },
      ],
      evaluation: evaluationFor(false),
    });

    const verdict = allGatingScorersPassed(scores, evaluationConfig);
    expect(verdict.unresolvedScorerIds).toEqual([]);

    // And the reason: every gating definition has a row, and every row scored.
    //
    // Joined BY `definitionHash`, which is what `allGatingScorersPassed` joins
    // on. Matching on `scorerId` would let this pass while a definition was
    // genuinely unresolved: two definitions can share an id under different
    // hashes (that is exactly what a version or match-option change produces),
    // and only one of them having a row is the case worth catching.
    const rowHashes = new Set(scores.map((row) => row.definitionHash));
    const gating = evaluationConfig.definitions.filter(
      (definition) => definition.role === "gating"
    );
    expect(gating.length).toBeGreaterThan(0);
    expect(
      gating
        .filter((d) => !rowHashes.has(definitionHash(d)))
        .map((d) => d.scorerId)
    ).toEqual([]);
    expect(
      scores.filter((row) => row.status !== "scored").map((r) => r.scorerId)
    ).toEqual([]);
  });

  test("a disagreeing row carries the SAME verdict the boolean gate reads", () => {
    // The mechanism behind "a first-pass disagreement only happens where the
    // boolean also failed" — asserted directly, rather than by re-deriving the
    // boolean verdict through `buildEvalIterationVerdict` (which needs a full
    // turn/trace harness, and is pinned by `iteration-verdict-pinned.test.ts`).
    //
    // The rows are a PROJECTION of the same evaluation: a predicate row's
    // `passed` IS the `PredicateResult.passed` the boolean gate consumes, and
    // the tool-match row's is `evaluation.passed`. So a row can only disagree
    // where the value the boolean also read was false. If that projection ever
    // stops being faithful, this fails — and the claim in `buildScoreMetadata`
    // that the two "cannot honestly disagree" stops being true with it.
    // A MIXED set, so this pins per-criterion faithfulness rather than only
    // "something failed": with one passing and one failing predicate, exactly
    // the failing one may disagree.
    const predicateResults = [
      { predicate: passingPredicate, passed: true },
      { predicate: failingPredicate, passed: false },
    ];
    const { scores, evaluationConfig } = buildHostedScoreContract({
      predicateResults,
      evaluation: evaluationFor(true),
    });

    const verdict = allGatingScorersPassed(scores, evaluationConfig);
    expect(verdict.passed).toBe(false);
    expect(verdict.unresolvedScorerIds).toEqual([]);

    // The projection is IDENTITY on the value the boolean gate reads: each
    // predicate row's `passed` is the `PredicateResult.passed` that was handed
    // in, matched back by the same `hostedCriterionId` the definition is keyed
    // on. Asserting the row is merely `false` would hold even if the projection
    // had inverted a different criterion; this would not.
    const byScorerId = new Map(scores.map((row) => [row.scorerId, row]));
    for (const result of predicateResults) {
      const row = byScorerId.get(
        `predicate:${hostedCriterionId(result.predicate)}`
      );
      expect(row, "every predicate handed in is projected as a row").toBeDefined();
      expect(row!.status).toBe("scored");
      expect(row!.passed).toBe(result.passed);
    }

    // So exactly the criteria the boolean gate saw fail are the ones that
    // disagree — never evidence the boolean never saw.
    expect([...verdict.disagreeingScorerIds].sort()).toEqual(
      predicateResults
        .filter((result) => !result.passed)
        .map((result) => `predicate:${hostedCriterionId(result.predicate)}`)
        .sort()
    );
  });
});

describe("the returned params carry the verdict the run must aggregate", () => {
  test("no gating row this path builds is unresolvable, so the strictness catch cannot fire here", () => {
    // The claim this file makes about `enforce` has two halves, and only one of
    // them is reachable through `buildIterationFinishParams`.
    //
    // A gating row that DISAGREES flips a reported pass to failed — pinned
    // above ("the rows still FAIL an iteration the boolean pipeline passed").
    //
    // A gating row that is UNRESOLVABLE — `error` or `skipped` — would too, and
    // that is the half `enforce` was principally sold on. It cannot happen
    // here. This path takes no judge verdict, and the only rows it builds
    // (predicates, the tool matcher) go through `fromCriterionResult`, which
    // always yields `status: "scored"`. `unresolvedScorerIds` is therefore
    // structurally empty on the hosted first pass.
    //
    // This is worth a test rather than a comment because it sets the
    // expectation for the ramp: a hosted `enforce` cohort showing ZERO verdict
    // changes from unresolved rows is the CORRECT result, not evidence that the
    // flag failed to take effect. The strictness catch lives on SDK-reported
    // runs and on the judge second pass, which do produce error rows.
    //
    // If a future change gives this path an unresolvable gating row, this test
    // fails — and the soak's baseline has to be re-read, not the test relaxed.
    for (const entry of CORPUS) {
      const params = build({
        passed: entry.reportedPassed,
        ...(entry.predicateResults
          ? { predicateResults: entry.predicateResults }
          : {}),
        evaluation: evaluationFor(entry.evaluationPassed),
        ...(entry.isNegativeTest ? { isNegativeTest: true } : {}),
      });
      const metadata = params.metadata as Record<string, unknown>;
      const scores = metadata.scores as Array<{ status: string }>;
      const config = metadata.evaluationConfig as never;

      expect(
        scores.length,
        `${entry.label}: there are rows to make a claim about`,
      ).toBeGreaterThan(0);
      expect(
        allGatingScorersPassed(scores as never, config).unresolvedScorerIds,
        `${entry.label}: no unresolved gating row is reachable here`,
      ).toEqual([]);
      expect(
        scores.every((row) => row.status === "scored"),
        `${entry.label}: every row this path builds is scored`,
      ).toBe(true);
    }
  });
});
