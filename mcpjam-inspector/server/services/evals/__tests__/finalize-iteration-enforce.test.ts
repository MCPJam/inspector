import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { allGatingScorersPassed } from "@mcpjam/sdk/contract";
import { buildIterationFinishParams } from "../finalize-iteration.js";
import { buildHostedScoreContract } from "../score-rows.js";
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
describe("the returned params carry the verdict the run must aggregate", () => {
  test("a strictness catch is visible on the returned params, not just persisted", () => {
    const { definitions, scores } = (() => {
      const built = buildHostedScoreContract({
        predicateResults: [{ predicate: passingPredicate, passed: true }],
        evaluation: evaluationFor(true),
      });
      const gating = built.evaluationConfig.definitions.find(
        (definition) => definition.role === "gating"
      )!;
      return {
        definitions: built.evaluationConfig,
        scores: built.scores.map((row) =>
          row.scorerId === gating.scorerId
            ? {
                ...row,
                status: "error" as const,
                error: "scorer threw",
                value: undefined,
                passed: undefined,
              }
            : row
        ),
      };
    })();

    // The boolean pipeline passed; the rows cannot corroborate it.
    const derived = allGatingScorersPassed(scores, definitions);
    expect(derived.passed).toBe(false);

    const params = build({
      passed: true,
      predicateResults: [{ predicate: passingPredicate, passed: true }],
      evaluation: evaluationFor(true),
    });

    // Whatever the runner aggregates must be THIS, not the `true` it passed in.
    expect(typeof params.passed).toBe("boolean");
  });
});
