/**
 * The verdict-policy contract — the shapes a v2 eval verdict travels in.
 *
 * B4-W1 ships a CONTRACT, not a producer, so the tests are about what the
 * validators refuse and what the fixtures pin:
 *
 *  1. **Fixture parity.** Every `accept` row parses, every `reject` row is
 *     refused, and every `roundTrip` row survives a parse unchanged (no
 *     `.default()` materialized an omitted key). The same rows are the corpus
 *     the backend mirror will load in B4-W2.
 *  2. **Non-finite and percent-shaped numbers.** `NaN` / `±Infinity` are not
 *     JSON values, so they cannot live in the fixture file and are asserted
 *     here directly, alongside the percent-like inputs that are the likely
 *     migration bug from the legacy percent thresholds.
 *  3. **Version discipline.** An absent `verdictPolicyVersion` is a LEGACY row
 *     and is never read as v2. This is the assertion that keeps old
 *     percent-threshold numbers from being restated under new semantics.
 *  4. **Suite inheritance and case override.** `effectivePassThreshold` and
 *     `configuredTrials` are the RESOLVED values, so the loader's resolution is
 *     exercised end to end rather than assumed.
 *  5. **Expected aggregation output.** The `aggregation` cohort's expected rows
 *     are re-derived from their own trial lists, so a hand-typed number cannot
 *     drift from the arithmetic it claims. Deriving here — in a test — is
 *     deliberate: this wave adds no runtime aggregator.
 */

import { describe, expect, it } from "vitest";
import {
  EVAL_RATE_MEASUREMENT_STATES,
  EVAL_RUN_VERDICTS,
  EVAL_TRIAL_EXCLUSION_REASONS,
  EVAL_VALIDITY_DECISION_REASONS,
  EVAL_VERDICT_DECISION_REASONS,
  EVAL_VERDICT_POLICY_SCHEMA_ID,
  EVAL_VERDICT_POLICY_VERSION,
  evalCaseVerdictAggregationSchema,
  evalFractionSchema,
  evalRateMeasurementSchema,
  evalRunVerdictSchema,
  evalVerdictDecisionSchema,
  evalVerdictPolicyVersionSchema,
  isEvalRunVerdict,
  isEvalTrialExclusionReason,
  isEvalValidityDecisionReason,
  isEvalVerdictDecisionReason,
  isEvalVerdictPolicyV2,
  resolvedEvalValidityPolicySchema,
  type EvalCaseVerdictAggregation,
  type EvalVerdictDecision,
} from "../src/contract/verdict-policy.js";
import { ITERATION_STATUSES } from "../src/contract/chain.js";
import { MAX_REPETITIONS } from "../src/contract/suite-file.js";
import {
  SUITE_FILE_DEFAULT_COVERAGE,
  resolveEvalSuiteFile,
} from "../src/suite-file-loader.js";
import type { EvalSuiteFile } from "../src/contract/suite-file.js";
import {
  deriveCaseCounts,
  findFixture,
  rowsOfKind,
  stripAnnotations,
  verdictPolicyFixtures as data,
  verdictPolicyPayload,
  type VerdictPolicyFixtureKind,
  type VerdictPolicyFixtureRow,
} from "./support/eval-verdict-policy-fixtures.js";

/** The validator each `__kind` dispatches to. */
function parseRow(row: VerdictPolicyFixtureRow) {
  const payload = verdictPolicyPayload(row);
  const validators: Record<
    VerdictPolicyFixtureKind,
    (input: unknown) => { success: boolean; error?: unknown }
  > = {
    decision: (input) => evalVerdictDecisionSchema.safeParse(input),
    case: (input) => evalCaseVerdictAggregationSchema.safeParse(input),
    rate: (input) => evalRateMeasurementSchema.safeParse(input),
    policy: (input) => resolvedEvalValidityPolicySchema.safeParse(input),
  };
  const validator = validators[row.__kind];
  if (!validator) {
    throw new Error(`fixture "${row.__label}" has unknown __kind`);
  }
  return validator(payload);
}

describe("verdict policy — fixture parity", () => {
  for (const row of data.accept) {
    it(`accepts (${row.__kind}): ${row.__label}`, () => {
      const result = parseRow(row);
      if (!result.success) {
        throw new Error(
          `zod rejected an accept fixture "${row.__label}":\n` +
            JSON.stringify(result.error, null, 2)
        );
      }
      expect(result.success).toBe(true);
    });
  }

  for (const row of data.reject) {
    it(`rejects (${row.__kind}): ${row.__label}`, () => {
      expect(parseRow(row).success).toBe(false);
    });
  }

  it("covers every cohort the mirror will load", () => {
    // A cohort that quietly emptied would make the loops above vacuous, and the
    // backend mirror would import a corpus that proves nothing.
    expect(data.accept.length).toBeGreaterThan(15);
    expect(data.reject.length).toBeGreaterThan(15);
    expect(data.roundTrip.length).toBeGreaterThan(0);
    expect(data.aggregation.length).toBeGreaterThan(5);
    for (const kind of ["decision", "case", "rate", "policy"] as const) {
      const present =
        rowsOfKind(data.accept, kind).length +
        rowsOfKind(data.reject, kind).length;
      expect(present, `no fixture row of kind "${kind}"`).toBeGreaterThan(0);
    }
  });
});

describe("verdict policy — a payload survives a round trip unchanged", () => {
  for (const row of data.roundTrip) {
    it(`round-trips: ${row.__label}`, () => {
      const authored = verdictPolicyPayload(row);
      const parsed = evalVerdictDecisionSchema.parse(authored);
      // Deep-equal AND a literal key comparison: a materialized default shows up
      // as a KEY, and `toEqual` treats `{}` and `{ cancelled: 0 }` as different
      // objects but a careless reader as the same thing.
      expect(parsed).toEqual(authored);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(authored));
    });
  }

  it("never materializes an omitted exclusion count", () => {
    const row = findFixture(
      data.roundTrip,
      "roundTrip — a fully measured decision"
    );
    const parsed = evalVerdictDecisionSchema.parse(verdictPolicyPayload(row));
    expect(parsed.cases[0]?.passRate.exclusions).toEqual({});
    expect(
      Object.keys(parsed.cases[0]?.passRate.exclusions ?? {})
    ).toHaveLength(0);
  });
});

describe("verdict policy — version discipline", () => {
  it("pins the literal version and its published $id", () => {
    expect(EVAL_VERDICT_POLICY_VERSION).toBe(2);
    expect(EVAL_VERDICT_POLICY_SCHEMA_ID).toBe(
      "https://mcpjam.com/schemas/eval-verdict-policy/v2.json"
    );
  });

  it("does NOT read a missing verdictPolicyVersion as v2", () => {
    // The legacy percent-threshold rows carry no version at all. Defaulting one
    // in would restate their numbers under trial-fraction semantics — a silent
    // reinterpretation of history, which is worse than a loud rejection.
    expect(isEvalVerdictPolicyV2(undefined)).toBe(false);
    expect(isEvalVerdictPolicyV2(null)).toBe(false);
    expect(isEvalVerdictPolicyV2(1)).toBe(false);
    expect(isEvalVerdictPolicyV2("2")).toBe(false);
    expect(isEvalVerdictPolicyV2(2)).toBe(true);

    expect(evalVerdictPolicyVersionSchema.safeParse(undefined).success).toBe(
      false
    );
    const message =
      evalVerdictPolicyVersionSchema.safeParse(undefined).error?.issues[0]
        ?.message;
    expect(message).toContain("LEGACY");

    const legacyShaped = {
      ...(stripAnnotations(
        findFixture(data.roundTrip, "roundTrip — a fully measured decision")
      ) as Record<string, unknown>),
    };
    delete legacyShaped.verdictPolicyVersion;
    expect(evalVerdictDecisionSchema.safeParse(legacyShaped).success).toBe(
      false
    );
  });
});

describe("verdict policy — fractions are finite reals in [0,1], never percents", () => {
  it("rejects non-finite numbers, which JSON cannot even express", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
      expect(
        evalFractionSchema.safeParse(value).success,
        `${value} must not be a fraction`
      ).toBe(false);
    }
  });

  it("accepts the boundaries and rejects everything outside them", () => {
    for (const value of [0, 0.5, 1]) {
      expect(evalFractionSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [-0.000001, 1.000001, 50, 80, 100, -1]) {
      expect(
        evalFractionSchema.safeParse(value).success,
        `${value} is not in [0,1]`
      ).toBe(false);
    }
    // A percent-shaped 50 is the migration bug this bound exists to catch.
    expect(evalFractionSchema.safeParse(50).success).toBe(false);
  });

  it("rejects a non-finite rate value inside an otherwise valid envelope", () => {
    expect(
      evalRateMeasurementSchema.safeParse({
        state: "measured",
        value: Number.NaN,
        numerator: 1,
        denominator: 2,
        exclusions: {},
      }).success
    ).toBe(false);
  });
});

describe("verdict policy — repetitions use the portable suite-file range", () => {
  const caseAt = (configuredTrials: number): EvalCaseVerdictAggregation =>
    ({
      caseId: "c_alpha",
      configuredTrials,
      attemptedTrials: 1,
      eligibleTrials: 1,
      passedTrials: 1,
      failedTrials: 0,
      effectivePassThreshold: 0.5,
      passRate: {
        state: "measured",
        value: 1,
        numerator: 1,
        denominator: 1,
        exclusions: {},
      },
      completionRate: {
        state: "measured",
        value: 1,
        numerator: 1,
        denominator: 1,
        exclusions: {},
      },
      observedStability: {
        state: "measured",
        value: 1,
        numerator: 1,
        denominator: 1,
        exclusions: {},
      },
      mixedVerdict: false,
      verdict: "passed",
      reason: "casePassRateMetThreshold",
    } as EvalCaseVerdictAggregation);

  it("accepts 1 and 100 and rejects 0 and 101", () => {
    expect(MAX_REPETITIONS).toBe(100);
    expect(evalCaseVerdictAggregationSchema.safeParse(caseAt(1)).success).toBe(
      true
    );
    expect(
      evalCaseVerdictAggregationSchema.safeParse({
        ...caseAt(100),
        attemptedTrials: 1,
      }).success
    ).toBe(true);
    expect(evalCaseVerdictAggregationSchema.safeParse(caseAt(0)).success).toBe(
      false
    );
    expect(
      evalCaseVerdictAggregationSchema.safeParse(caseAt(101)).success
    ).toBe(false);
  });

  it("does not encode the hosted platform's lower per-case cap", () => {
    // The hosted runner caps repetitions far below 100. That is a PRODUCT limit
    // enforced where runs are launched; baking it in here would make a
    // perfectly legal portable suite file's results unrepresentable.
    expect(evalCaseVerdictAggregationSchema.safeParse(caseAt(11)).success).toBe(
      true
    );
  });
});

describe("verdict policy — closed vocabularies", () => {
  it("exposes the verdicts, states, exclusions and reasons as closed sets", () => {
    expect(EVAL_RUN_VERDICTS).toEqual(["passed", "failed", "inconclusive"]);
    expect(EVAL_RATE_MEASUREMENT_STATES).toEqual(["measured", "notMeasured"]);
    expect(EVAL_TRIAL_EXCLUSION_REASONS).toContain("cancelled");
    expect(EVAL_TRIAL_EXCLUSION_REASONS).toContain("skipped");
    expect(EVAL_TRIAL_EXCLUSION_REASONS).toContain("setupFailed");
    expect(EVAL_TRIAL_EXCLUSION_REASONS).toContain("evaluatorError");
    expect(new Set(EVAL_VERDICT_DECISION_REASONS).size).toBe(
      EVAL_VERDICT_DECISION_REASONS.length
    );
    for (const reason of EVAL_VALIDITY_DECISION_REASONS) {
      expect(EVAL_VERDICT_DECISION_REASONS).toContain(reason);
      expect(isEvalValidityDecisionReason(reason)).toBe(true);
    }
  });

  it("guards refuse near-misses", () => {
    expect(isEvalRunVerdict("incomplete")).toBe(false);
    expect(isEvalRunVerdict("inconclusive")).toBe(true);
    expect(isEvalTrialExclusionReason("setup_failed")).toBe(false);
    expect(isEvalTrialExclusionReason("setupFailed")).toBe(true);
    expect(isEvalVerdictDecisionReason("passRateBelowThreshold")).toBe(false);
    expect(evalRunVerdictSchema.safeParse("incomplete").success).toBe(false);
  });

  it("keeps lifecycle status and task verdict ORTHOGONAL", () => {
    // Two vocabularies describing different things: what happened to a trial,
    // and whether the case's goal was met. There is no mapper between them in
    // this wave, and the lifecycle words are deliberately not verdict words.
    expect(ITERATION_STATUSES).toEqual([
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "setup_failed",
      "skipped",
    ]);
    // Only ONE word appears in both vocabularies, and it means different
    // things on each side: a lifecycle `failed` trial broke mechanically and
    // has NO task verdict to grade (it is excluded as `executionFailed`),
    // whereas a `failed` verdict is a graded outcome. That collision is why
    // this wave adds no status-to-verdict mapper: the two would look
    // interchangeable and are not.
    const collisions = ITERATION_STATUSES.filter((status) =>
      isEvalRunVerdict(status)
    );
    expect(collisions).toEqual(["failed"]);
    expect(isEvalRunVerdict("completed")).toBe(false);
    expect(isEvalRunVerdict("timed_out")).toBe(false);
    const mechanical = data.aggregation.find((row) =>
      row.__label.startsWith("executionFailed and timedOut")
    );
    const failedTrial = mechanical?.input.trials.find(
      (trial) => trial.status === "failed"
    );
    expect(failedTrial?.taskVerdict).toBeUndefined();
    // …and the normal way a case fails is trials that ran to `completed` with a
    // failing task verdict, which is a FAILED verdict, not an inconclusive one.
    const allFail = evalVerdictDecisionSchema.parse(
      verdictPolicyPayload(
        findFixture(data.accept, "all fail at threshold 0.5")
      )
    );
    expect(allFail.verdict).toBe("failed");
    expect(allFail.validity.holds).toBe(true);
    expect(
      allFail.cases[0]?.completionRate.value,
      "every trial completed mechanically"
    ).toBe(1);
  });
});

describe("verdict policy — validity is decided before the task verdict", () => {
  const decisionFor = (labelPrefix: string): EvalVerdictDecision =>
    evalVerdictDecisionSchema.parse(
      verdictPolicyPayload(findFixture(data.accept, labelPrefix))
    );

  it("reads the resolved suite-file defaults as its coverage policy", () => {
    const policy = resolvedEvalValidityPolicySchema.parse(
      verdictPolicyPayload(
        findFixture(data.accept, "policy — omitted minEligibleTrials")
      )
    );
    expect(policy.coverage).toEqual(SUITE_FILE_DEFAULT_COVERAGE);
    expect(policy.minCompletionRate).toBe(0.8);
    expect(policy.maxEvaluatorErrorRate).toBe(0.1);
  });

  it("an unattempted configured trial is inconclusive under the default rule", () => {
    const decision = decisionFor("default coverage rule");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.validity.holds).toBe(false);
    expect(decision.reasons).toContain("configuredTrialsNotAttempted");
    // Every case that WAS graded passed. The run still says nothing.
    expect(decision.cases.every((entry) => entry.verdict === "passed")).toBe(
      true
    );
  });

  it("an explicit minEligibleTrials replaces the coverage rule", () => {
    const decision = decisionFor("explicit minEligibleTrials 4");
    expect(decision.validity.policy.coverage).toEqual({
      kind: "minEligibleTrials",
      minEligibleTrials: 4,
    });
    // The explicit floor tolerates ungraded trials: 4 of 5 were eligible.
    expect(decision.validity.eligibleTrials).toBe(4);
    expect(decision.validity.holds).toBe(true);
    expect(decision.verdict).toBe("passed");

    // …and it tolerates trials that were never ATTEMPTED, which is exactly
    // what the default coverage rule refuses.
    const partial = decisionFor("skipped and non-terminal trials");
    expect(partial.validity.attemptedTrials).toBeLessThan(
      partial.validity.configuredTrials
    );
    expect(partial.validity.holds).toBe(true);
    expect(partial.verdict).toBe("passed");
  });

  it("holds at the 0.8 completion boundary and fails below it", () => {
    const boundary = decisionFor("explicit minEligibleTrials 4");
    expect(boundary.validity.completionRate.value).toBe(0.8);
    expect(boundary.validity.holds).toBe(true);

    const below = decisionFor("completion rate 0.6 below the 0.8 floor");
    expect(below.validity.completionRate.value).toBe(0.6);
    expect(below.verdict).toBe("inconclusive");
    expect(below.reasons).toContain("completionRateBelowMinimum");
  });

  it("holds at the 0.1 evaluator-error boundary and fails above it", () => {
    const boundary = decisionFor("evaluator error rate exactly 0.1");
    expect(boundary.validity.evaluatorErrorRate.value).toBe(0.1);
    expect(boundary.validity.holds).toBe(true);

    const above = decisionFor("evaluator error rate 0.2 above the 0.1 ceiling");
    expect(above.validity.evaluatorErrorRate.value).toBe(0.2);
    expect(above.verdict).toBe("inconclusive");
    expect(above.reasons).toContain("evaluatorErrorRateAboveMaximum");
  });

  it("treats a notMeasured rate as unsatisfiable, not as a zero", () => {
    const nothing = decisionFor("nothing attempted");
    expect(nothing.validity.completionRate.state).toBe("notMeasured");
    expect(nothing.validity.completionRate.value).toBeNull();
    expect(nothing.verdict).toBe("inconclusive");
    expect(nothing.reasons).toContain("completionRateNotMeasured");
    // The evaluator-error CEILING is also unsatisfiable: an absent measurement
    // does not pass a bound from either direction.
    expect(nothing.reasons).toContain("evaluatorErrorRateNotMeasured");
  });

  it("one unmeasured case forces the whole run inconclusive", () => {
    const decision = decisionFor("one unmeasured case forces");
    expect(decision.verdict).toBe("inconclusive");
    expect(decision.reasons).toContain("caseHasNoEligibleTrials");
    // Its threshold is 0 and it still cannot pass: nothing was graded.
    const unmeasured = decision.cases.find(
      (entry) => entry.eligibleTrials === 0
    );
    expect(unmeasured?.effectivePassThreshold).toBe(0);
    expect(unmeasured?.verdict).toBe("inconclusive");
    // …while the case that WAS measured passed on its own terms.
    expect(
      decision.cases.find((entry) => entry.eligibleTrials > 0)?.verdict
    ).toBe("passed");
  });

  it("passes only when every measured case meets its own threshold", () => {
    const inherited = decisionFor("suite inheritance and case override");
    expect(inherited.verdict).toBe("passed");
    expect(inherited.reasons).toEqual(["allMeasuredCasesMetThreshold"]);

    const failed = decisionFor("threshold 1.0 with one failure");
    expect(failed.validity.holds).toBe(true);
    expect(failed.verdict).toBe("failed");
    expect(failed.reasons).toEqual(["casePassRateBelowThreshold"]);
  });
});

describe("verdict policy — thresholds at 0, 0.5 and 1, equality included", () => {
  const caseFor = (labelPrefix: string): EvalCaseVerdictAggregation => {
    const decision = evalVerdictDecisionSchema.parse(
      verdictPolicyPayload(findFixture(data.accept, labelPrefix))
    );
    const [first] = decision.cases;
    if (!first) throw new Error(`no case in fixture "${labelPrefix}"`);
    return first;
  };

  it("equality passes at 0.5", () => {
    const entry = caseFor("mixed pass and fail at threshold 0.5");
    expect(entry.passRate.value).toBe(0.5);
    expect(entry.effectivePassThreshold).toBe(0.5);
    expect(entry.verdict).toBe("passed");
    expect(entry.mixedVerdict).toBe(true);
  });

  it("equality passes at 1", () => {
    const entry = caseFor("all pass at threshold 1.0");
    expect(entry.passRate.value).toBe(1);
    expect(entry.effectivePassThreshold).toBe(1);
    expect(entry.verdict).toBe("passed");
  });

  it("a measured all-fail case passes at threshold 0 — and has stability 1", () => {
    const entry = caseFor("all fail at threshold 0");
    expect(entry.effectivePassThreshold).toBe(0);
    expect(entry.passRate.value).toBe(0);
    expect(entry.observedStability.value).toBe(1);
    expect(entry.verdict).toBe("passed");
    // Stability describes AGREEMENT, not quality: this case never passed once.
    expect(entry.passedTrials).toBe(0);
    expect(entry.mixedVerdict).toBe(false);
  });

  it("but a case with zero eligible trials is inconclusive at threshold 0", () => {
    const decision = evalVerdictDecisionSchema.parse(
      verdictPolicyPayload(findFixture(data.accept, "one unmeasured case"))
    );
    const unmeasured = decision.cases.find(
      (entry) => entry.eligibleTrials === 0
    );
    expect(unmeasured?.effectivePassThreshold).toBe(0);
    expect(unmeasured?.passRate.state).toBe("notMeasured");
    expect(unmeasured?.verdict).toBe("inconclusive");
    expect(unmeasured?.reason).toBe("caseHasNoEligibleTrials");
  });
});

describe("verdict policy — effective thresholds come from the resolved suite file", () => {
  const SUITE: EvalSuiteFile = {
    schemaVersion: 1,
    mode: "local",
    reportingMode: "standard",
    suite: { id: "s_inheritance", name: "inheritance" },
    target: { kind: "servers", servers: [{ name: "billing", url: "stdio" }] },
    defaults: {
      model: "gpt-4o-mini",
      repetitions: 2,
      passThreshold: 0.5,
      validity: {},
    },
    cases: [
      {
        id: "c_inherited",
        title: "inherits both",
        steps: [{ id: "step-1", kind: "prompt", prompt: "hello" }],
      },
      {
        id: "c_override",
        title: "overrides both",
        repetitions: 1,
        passThreshold: 1,
        steps: [{ id: "step-1", kind: "prompt", prompt: "hello" }],
      },
    ],
  } as unknown as EvalSuiteFile;

  it("resolves inheritance and override into the numbers a decision carries", () => {
    const resolved = resolveEvalSuiteFile(SUITE);
    const [inherited, overridden] = resolved.cases;
    expect(inherited?.passThreshold).toBe(0.5);
    expect(inherited?.repetitions).toBe(2);
    expect(overridden?.passThreshold).toBe(1);
    expect(overridden?.repetitions).toBe(1);

    // The fixture's two cases carry exactly those resolved values, which is
    // what `effectivePassThreshold` and `configuredTrials` mean: a decision
    // never re-reads the suite file to find out what a case was asked to do.
    const decision = evalVerdictDecisionSchema.parse(
      verdictPolicyPayload(
        findFixture(data.accept, "suite inheritance and case override")
      )
    );
    const byId = new Map(
      decision.cases.map((entry) => [entry.caseId, entry] as const)
    );
    expect(byId.get("c_inherited")?.effectivePassThreshold).toBe(0.5);
    expect(byId.get("c_override")?.effectivePassThreshold).toBe(1);
  });
});

describe("verdict policy — the expected aggregation output is self-consistent", () => {
  // This wave ships NO aggregator. The derivation here is fixture arithmetic:
  // it proves the expected rows follow from their own trial lists, so the
  // producer that arrives in a later wave has a corpus to be checked against
  // rather than a set of hand-typed numbers to be trusted.
  for (const row of data.aggregation) {
    it(`derives: ${row.__label}`, () => {
      const { input, expected } = row;
      expect(input.trials).toHaveLength(input.configuredTrials);
      const counts = deriveCaseCounts(input.trials);

      const parsed = evalCaseVerdictAggregationSchema.parse(expected);
      expect(parsed.caseId).toBe(input.caseId);
      expect(parsed.configuredTrials).toBe(input.configuredTrials);
      expect(parsed.effectivePassThreshold).toBe(input.effectivePassThreshold);
      expect(parsed.attemptedTrials).toBe(counts.attempted);
      expect(parsed.eligibleTrials).toBe(counts.eligible);
      expect(parsed.passedTrials).toBe(counts.passed);
      expect(parsed.failedTrials).toBe(counts.failed);
      expect(parsed.mixedVerdict).toBe(counts.passed > 0 && counts.failed > 0);

      if (counts.eligible === 0) {
        expect(parsed.verdict).toBe("inconclusive");
        expect(parsed.reason).toBe("caseHasNoEligibleTrials");
        expect(parsed.passRate.state).toBe("notMeasured");
        expect(parsed.passRate.value).toBeNull();
        expect(parsed.observedStability.state).toBe("notMeasured");
      } else {
        expect(parsed.passRate.value).toBe(counts.passed / counts.eligible);
        expect(parsed.observedStability.value).toBe(
          Math.max(counts.passed, counts.failed) / counts.eligible
        );
        const met =
          counts.passed / counts.eligible >= input.effectivePassThreshold;
        expect(parsed.verdict).toBe(met ? "passed" : "failed");
      }

      if (counts.attempted === 0) {
        expect(parsed.completionRate.state).toBe("notMeasured");
      } else {
        expect(parsed.completionRate.value).toBe(
          counts.completed / counts.attempted
        );
      }

      expect(parsed.passRate.exclusions).toEqual(counts.eligibilityExclusions);
      expect(parsed.completionRate.exclusions).toEqual(
        counts.attemptExclusions
      );
    });
  }

  it("covers every exclusion reason the vocabulary declares", () => {
    const seen = new Set<string>();
    for (const row of data.aggregation) {
      const counts = deriveCaseCounts(row.input.trials);
      for (const reason of Object.keys(counts.eligibilityExclusions)) {
        seen.add(reason);
      }
    }
    for (const reason of [
      "cancelled",
      "skipped",
      "setupFailed",
      "evaluatorError",
      "executionFailed",
    ]) {
      expect(seen, `no aggregation row excludes "${reason}"`).toContain(reason);
    }
  });
});
