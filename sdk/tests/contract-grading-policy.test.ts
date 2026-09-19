/**
 * The ONE grading policy, against the shared corpus.
 *
 * Every cohort here is also the backend's (G0b): the fixture file is copied
 * verbatim into `mcpjam-backend`, so a rule that passes here and not there is a
 * divergence the mirror check catches rather than a rule that quietly holds in
 * one runtime.
 */

import { describe, expect, it } from "vitest";
import {
  EVAL_GRADING_POLICY_ORIGINS,
  EVAL_GRADING_POLICY_REFUSALS,
  EVAL_SUITE_WIDE_POPULATIONS,
  LEGACY_SUITE_WIDE_THRESHOLD_PERCENT,
  MAX_MINIMUM_ITERATIONS,
  SUITE_FILE_DEFAULT_COVERAGE,
  SUITE_FILE_VALIDITY_DEFAULTS,
  evalGradingPolicySchema,
  evalPassCriterionFraction,
  hostedGradingStorageFromDto,
  planEvalGradingPolicyEdit,
  resolveEvalGradingIterations,
  resolveEvalGradingValidityPolicy,
  resolveGradingPolicyFromHostedSuite,
  resolveGradingPolicyFromRunReporting,
  resolveGradingPolicyFromSuiteFile,
  type EvalGradingPolicyEdit,
  type EvalPassCriterion,
  type ResolvedEvalGradingPolicy,
} from "../src/contract/grading-policy.js";
import { passRateFractionFromPercent } from "../src/gates.js";
import {
  SUITE_FILE_DEFAULT_COVERAGE as LOADER_DEFAULT_COVERAGE,
  SUITE_FILE_VALIDITY_DEFAULTS as LOADER_VALIDITY_DEFAULTS,
} from "../src/suite-file-loader.js";
import {
  LEGACY_SUMMARY_PRODUCERS,
  deriveFailingCases,
  deriveSuiteWideRate,
  gradingPolicyFixtures,
  stripAnnotations,
  type PolicySourceRef,
} from "./support/eval-grading-policy-fixtures.js";

const fixtures = gradingPolicyFixtures;

function resolveFrom(ref: PolicySourceRef): ResolvedEvalGradingPolicy {
  const value = stripAnnotations(ref.value) as Record<string, any>;
  if (ref.source === "suiteFile") {
    return resolveGradingPolicyFromSuiteFile(value as any);
  }
  if (ref.source === "hostedSuite") {
    return resolveGradingPolicyFromHostedSuite(value as any);
  }
  return resolveGradingPolicyFromRunReporting(value as any);
}

describe("grading policy — the corpus is loadable and complete", () => {
  it("carries every cohort the readme names", () => {
    expect(fixtures.__readme).toContain("ONE grading policy");
    expect(fixtures.normalization.length).toBeGreaterThan(0);
    expect(fixtures.reject.length).toBeGreaterThan(0);
    expect(fixtures.iterationResolution.length).toBeGreaterThan(0);
    expect(fixtures.thresholdConversion.length).toBeGreaterThan(0);
    expect(fixtures.scope.length).toBeGreaterThan(0);
    expect(fixtures.historicalSummaries.length).toBeGreaterThan(0);
    expect(fixtures.edits.length).toBeGreaterThan(0);
    expect(fixtures.rejectedEdits.length).toBeGreaterThan(0);
  });

  it("every historical-summary row names a run the corpus carries", () => {
    for (const row of fixtures.historicalSummaries) {
      expect(fixtures.runs[row.run], row.__label).toBeDefined();
    }
  });

  it("every row is labelled and explained", () => {
    const labelled = [
      ...fixtures.normalization,
      ...fixtures.reject,
      ...fixtures.iterationResolution,
      ...fixtures.scope,
      ...fixtures.historicalSummaries,
      ...fixtures.edits,
      ...fixtures.rejectedEdits,
    ];
    for (const row of labelled) {
      expect(typeof row.__label).toBe("string");
      expect(row.__label.length).toBeGreaterThan(0);
      expect(typeof row.__why).toBe("string");
      expect(row.__why.length).toBeGreaterThan(0);
    }
  });

  it("strips annotations recursively", () => {
    expect(
      stripAnnotations({ a: 1, __b: 2, c: { __d: 3, e: [{ __f: 4, g: 5 }] } })
    ).toEqual({ a: 1, c: { e: [{ g: 5 }] } });
  });
});

describe("grading policy — normalization", () => {
  for (const row of fixtures.normalization) {
    it(row.__label, () => {
      const resolved = resolveFrom(row.input);
      expect(resolved).toStrictEqual(stripAnnotations(row.expected));
      // The expected output is not just a shape somebody typed: it has to be a
      // legal policy, so a fixture cannot pin a model the contract refuses.
      expect(evalGradingPolicySchema.safeParse(resolved).success).toBe(true);
    });
  }

  it("refuses to read a per-case suite with no stored defaults", () => {
    expect(() =>
      resolveGradingPolicyFromHostedSuite({ verdictPolicyVersion: 2 })
    ).toThrow(/verdict policy 2 but carries no v2 defaults/);
  });

  it("an absent version is the suite-wide policy, never a defaulted per-case one", () => {
    const resolved = resolveGradingPolicyFromHostedSuite({});
    expect(resolved.passCriterion.scope).toBe("suiteWide");
    expect(resolved.origin).toBe("hostedSuiteWide");
    expect(resolved.validity.enforced).toBe(false);
  });

  it("reads the public settings DTO through the same adapter", () => {
    const fromDto = resolveGradingPolicyFromHostedSuite(
      hostedGradingStorageFromDto({
        minimumAccuracy: 90,
        minimumIterations: 3,
      })
    );
    expect(fromDto).toEqual(
      resolveGradingPolicyFromHostedSuite({
        defaultPassCriteria: { minimumPassRate: 90 },
        minIterations: 3,
      })
    );
  });

  it("a per-case DTO's null minimumAccuracy does not become a suite-wide policy", () => {
    const resolved = resolveGradingPolicyFromHostedSuite(
      hostedGradingStorageFromDto({
        minimumAccuracy: null,
        minimumIterations: 3,
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: { repetitions: 4, passThreshold: 0.75 },
      })
    );
    expect(resolved.passCriterion).toEqual({
      scope: "perCase",
      threshold: 0.75,
    });
    expect(resolved.iterationRule).toEqual({
      kind: "defaultCount",
      iterations: 4,
    });
  });

  it("an unchanged suite file resolves to the same policy every time", () => {
    const input = {
      defaults: { iterations: 3, passThreshold: 0.9, validity: {} },
      cases: [{ id: "c1", iterations: 5 }],
    };
    expect(resolveGradingPolicyFromSuiteFile(input)).toEqual(
      resolveGradingPolicyFromSuiteFile(input)
    );
  });

  it("an omitted and an empty stored validity block resolve identically", () => {
    const base = { repetitions: 3, passThreshold: 0.9 };
    const omitted = resolveGradingPolicyFromHostedSuite({
      verdictPolicyVersion: 2,
      verdictPolicyDefaults: base,
    });
    const empty = resolveGradingPolicyFromHostedSuite({
      verdictPolicyVersion: 2,
      verdictPolicyDefaults: { ...base, validity: {} },
    });
    expect(omitted).toEqual(empty);
    // …and neither can turn into the other, because an edit that changes
    // nothing writes nothing.
    for (const policy of [omitted, empty]) {
      const plan = planEvalGradingPolicyEdit(policy, { validity: {} });
      expect(plan.ok && plan.settings).toStrictEqual({});
    }
  });
});

describe("grading policy — refusals", () => {
  for (const row of fixtures.reject) {
    it(row.__label, () => {
      const value = stripAnnotations(row.value);
      if (row.kind === "hostedSuite") {
        expect(() =>
          resolveGradingPolicyFromHostedSuite(value as any)
        ).toThrow();
        return;
      }
      expect(evalGradingPolicySchema.safeParse(value).success).toBe(false);
    });
  }
});

describe("grading policy — iteration resolution", () => {
  for (const row of fixtures.iterationResolution) {
    it(row.__label, () => {
      expect(
        resolveEvalGradingIterations(
          stripAnnotations(row.rule),
          stripAnnotations(row.args)
        )
      ).toBe(row.expected);
    });
  }

  it("the floor's clamp ceiling matches the platform's", () => {
    expect(MAX_MINIMUM_ITERATIONS).toBe(10);
  });

  it("a floor is never a default count", () => {
    // A legacy case carries its count in `testCase.runs`, which the floor
    // RAISES; a per-case rule reads `testCase.repetitions`, a different column
    // that a legacy case does not have. So the same case resolves to 7 under a
    // floor of 3 and to the default 3 under a default count of 3 — a four-
    // iteration cut. That is why an `iterations` edit against a floor rule is
    // refused rather than written as the floor.
    expect(
      resolveEvalGradingIterations(
        { kind: "caseCountWithFloor", minimumIterations: 3 },
        { caseIterations: 7 }
      )
    ).toBe(7);
    expect(
      resolveEvalGradingIterations({ kind: "defaultCount", iterations: 3 }, {})
    ).toBe(3);
  });

  it("the two rules read different case columns", () => {
    // Pinned on the adapter rather than only on the resolver: a per-case suite
    // takes `repetitions` and ignores the legacy `runs` sitting beside it.
    const perCase = resolveGradingPolicyFromHostedSuite({
      verdictPolicyVersion: 2,
      verdictPolicyDefaults: { repetitions: 3, passThreshold: 0.9 },
      cases: [{ id: "k1", runs: 7 }],
    });
    expect(perCase.caseOverrides).toEqual([]);
    const suiteWide = resolveGradingPolicyFromHostedSuite({
      minIterations: 3,
      cases: [{ id: "k1", runs: 7 }],
    });
    expect(suiteWide.caseOverrides).toStrictEqual([
      { caseRef: "k1", iterations: 7 },
    ]);
  });
});

describe("grading policy — validity resolution", () => {
  it("an omitted minEligibleTrials selects the STRICTER coverage rule", () => {
    expect(resolveEvalGradingValidityPolicy({}).coverage).toEqual(
      SUITE_FILE_DEFAULT_COVERAGE
    );
    expect(resolveEvalGradingValidityPolicy().coverage).toEqual(
      SUITE_FILE_DEFAULT_COVERAGE
    );
  });

  it("an explicit minEligibleTrials REPLACES it", () => {
    expect(
      resolveEvalGradingValidityPolicy({ minEligibleTrials: 3 }).coverage
    ).toEqual({ kind: "minEligibleTrials", minEligibleTrials: 3 });
  });

  it("an explicit zero is not an omission", () => {
    const resolved = resolveEvalGradingValidityPolicy({
      minCompletionRate: 0,
      maxEvaluatorErrorRate: 0,
    });
    expect(resolved.minCompletionRate).toBe(0);
    expect(resolved.maxEvaluatorErrorRate).toBe(0);
  });

  it("omitted rates take the documented defaults", () => {
    const resolved = resolveEvalGradingValidityPolicy({});
    expect(resolved.minCompletionRate).toBe(0.8);
    expect(resolved.maxEvaluatorErrorRate).toBe(0.1);
  });

  it("the suite-file loader resolves through the SAME table", () => {
    // Re-exported rather than re-declared: three copies of "omission is
    // stricter" is three places for one of them to become `?? 1`.
    expect(LOADER_VALIDITY_DEFAULTS).toBe(SUITE_FILE_VALIDITY_DEFAULTS);
    expect(LOADER_DEFAULT_COVERAGE).toBe(SUITE_FILE_DEFAULT_COVERAGE);
  });
});

describe("grading policy — threshold units", () => {
  for (const row of fixtures.thresholdConversion) {
    it(`${row.fraction} is ${row.percent}%`, () => {
      // Read: percent → fraction, through the one sanctioned accessor.
      expect(
        evalPassCriterionFraction({
          scope: "suiteWide",
          thresholdPercent: row.percent,
          population: "iterations",
          emptyPopulationRate: 1,
        })
      ).toBeCloseTo(row.fraction, 12);
      // Write: fraction → percent, through the write adapter, with no float
      // noise surviving onto the wire.
      const policy = resolveGradingPolicyFromHostedSuite({
        defaultPassCriteria: { minimumPassRate: row.percent === 0 ? 50 : 0 },
      });
      const plan = planEvalGradingPolicyEdit(policy, {
        passThreshold: row.fraction,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.settings.minimumAccuracy).toBe(row.percent);
    });
  }

  it("a per-case threshold is already a fraction", () => {
    expect(
      evalPassCriterionFraction({ scope: "perCase", threshold: 0.9 })
    ).toBe(0.9);
  });

  it("agrees with the gate boundary's percent conversion", () => {
    // `contract/` sits below `src/`, so the two cannot share an import. This
    // pins them equal instead, so a change to either is a visible failure
    // rather than a threshold that means one thing at the gate and another in
    // the settings sheet.
    for (const percent of [0, 1, 7, 50, 90, 90.5, 99.9, 100]) {
      expect(
        evalPassCriterionFraction({
          scope: "suiteWide",
          thresholdPercent: percent,
          population: "iterations",
          emptyPopulationRate: 1,
        })
      ).toBe(passRateFractionFromPercent(percent));
    }
    expect(passRateFractionFromPercent(100)).toBe(1);
  });
});

describe("grading policy — scope decides what a threshold means", () => {
  for (const row of fixtures.scope) {
    describe(row.__label, () => {
      for (const check of row.checks) {
        const criterion = stripAnnotations(
          check.criterion
        ) as EvalPassCriterion;
        it(`${criterion.scope} ${
          criterion.scope === "perCase"
            ? criterion.threshold
            : `${criterion.thresholdPercent}% over ${criterion.population}`
        } → ${check.expected}`, () => {
          const iterations = row.run.iterations;
          if (criterion.scope === "suiteWide") {
            const rate = deriveSuiteWideRate(criterion, iterations);
            expect(rate).toBeCloseTo(check.expectedRate!, 12);
            const met = rate * 100 >= criterion.thresholdPercent;
            expect(met ? "passed" : "failed").toBe(check.expected);
            return;
          }
          const failing = deriveFailingCases(criterion, iterations);
          expect(failing).toEqual(check.expectedFailingCases ?? []);
          expect(failing.length === 0 ? "passed" : "failed").toBe(
            check.expected
          );
        });
      }
    });
  }

  it("the counterexample: 90% suite-wide passes what 0.9 per-case fails", () => {
    const row = fixtures.scope.find(
      (entry) =>
        entry.__label === "ten cases, nine always passing, one always failing"
    );
    expect(row).toBeDefined();
    const iterations = row!.run.iterations;
    expect(
      deriveSuiteWideRate(
        {
          scope: "suiteWide",
          thresholdPercent: 90,
          population: "iterations",
          emptyPopulationRate: 1,
        },
        iterations
      ) * 100
    ).toBeGreaterThanOrEqual(90);
    expect(
      deriveFailingCases({ scope: "perCase", threshold: 0.9 }, iterations)
    ).toHaveLength(1);
  });
});

describe("grading policy — the legacy producers disagree, and keep disagreeing", () => {
  for (const row of fixtures.historicalSummaries) {
    it(row.__label, () => {
      const iterations = fixtures.runs[row.run];
      for (const [name, expected] of Object.entries(row.expected)) {
        const produced = LEGACY_SUMMARY_PRODUCERS[
          name as keyof typeof LEGACY_SUMMARY_PRODUCERS
        ](iterations, row.minimumPassRate);
        expect(produced, `${name} on ${row.run}`).toEqual(expected);
      }
    });
  }

  it("an empty run is vacuously passing to one producer and failing to the others", () => {
    expect(LEGACY_SUMMARY_PRODUCERS.hostedFinalization([], 100).result).toBe(
      "passed"
    );
    expect(LEGACY_SUMMARY_PRODUCERS.sdkIngestion([], 100).result).toBe(
      "failed"
    );
    expect(LEGACY_SUMMARY_PRODUCERS.localFallback([], 100).result).toBe(
      "failed"
    );
  });

  it("the two suite-wide populations are both represented in the model", () => {
    expect([...EVAL_SUITE_WIDE_POPULATIONS]).toEqual([
      "iterations",
      "casesIgnoringExecutionVariant",
    ]);
  });
});

describe("grading policy — writing an edit back", () => {
  for (const row of fixtures.edits) {
    it(row.__label, () => {
      const policy = resolveFrom(row.policy);
      const plan = planEvalGradingPolicyEdit(
        policy,
        stripAnnotations(row.edit)
      );
      if (!row.expected.ok) {
        expect(plan.ok).toBe(false);
        if (plan.ok) return;
        expect(plan.refusal).toBe(row.expected.refusal);
        expect(plan.message.length).toBeGreaterThan(0);
        return;
      }
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.settings).toStrictEqual(row.expected.settings);
      expect([...plan.changed]).toEqual(row.expected.changed);
    });
  }

  for (const row of fixtures.rejectedEdits) {
    it(`refuses a malformed edit: ${row.__label}`, () => {
      const policy = resolveFrom(row.policy);
      expect(() =>
        planEvalGradingPolicyEdit(
          policy,
          stripAnnotations(row.edit) as EvalGradingPolicyEdit
        )
      ).toThrow(TypeError);
    });
  }

  it("a malformed edit throws rather than refusing", () => {
    // The two outcomes are different answers. A refusal is renderable: "this
    // suite cannot express that operation". A percent where a fraction belongs
    // is a programming error, and returning ok:false for it would invite a
    // caller to show a user a message about their suite.
    const policy = resolveGradingPolicyFromHostedSuite({
      defaultPassCriteria: { minimumPassRate: 90 },
    });
    expect(() =>
      planEvalGradingPolicyEdit(policy, {
        passThreshold: 90,
      })
    ).toThrow(/FRACTION in \[0,1\]/);
  });

  it("a threshold edit NEVER writes the pair that migrates a suite", () => {
    // `applyVerdictPolicySettings` reads `repetitions` + `passThreshold` on a
    // suite-wide suite as an upgrade. No edit against a suite-wide policy may
    // produce that pair, whatever it asks for.
    const policy = resolveGradingPolicyFromHostedSuite({
      defaultPassCriteria: { minimumPassRate: 90 },
    });
    for (const edit of [
      { passThreshold: 0.5 },
      { passThreshold: 0.5, minimumIterations: 4 },
      { minimumIterations: 2 },
      {},
    ]) {
      const plan = planEvalGradingPolicyEdit(policy, edit);
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      expect(plan.settings.repetitions).toBeUndefined();
      expect(plan.settings.passThreshold).toBeUndefined();
    }
  });

  it("a per-case edit never writes the legacy percent", () => {
    const policy = resolveGradingPolicyFromHostedSuite({
      verdictPolicyVersion: 2,
      verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
    });
    const plan = planEvalGradingPolicyEdit(policy, { passThreshold: 0.5 });
    expect(plan.ok && plan.settings).toStrictEqual({ passThreshold: 0.5 });
  });

  it("a refused edit carries no settings at all", () => {
    const policy = resolveGradingPolicyFromHostedSuite({
      defaultPassCriteria: { minimumPassRate: 90 },
    });
    const plan = planEvalGradingPolicyEdit(policy, {
      passThreshold: 0.5,
      iterations: 7,
    });
    expect(plan.ok).toBe(false);
    expect(plan).not.toHaveProperty("settings");
  });

  it("reading a policy and writing it straight back changes nothing", () => {
    // The hash/revision property, stated as a round trip: every stored policy
    // in the corpus, read and then re-written from what it says, produces an
    // empty patch.
    const sources: PolicySourceRef[] = fixtures.normalization
      .map((row) => row.input)
      .filter((input) => input.source === "hostedSuite");
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      let policy: ResolvedEvalGradingPolicy;
      try {
        policy = resolveFrom(source);
      } catch {
        continue;
      }
      const edit =
        policy.passCriterion.scope === "perCase"
          ? {
              passThreshold: policy.passCriterion.threshold,
              ...(policy.iterationRule.kind === "defaultCount"
                ? { iterations: policy.iterationRule.iterations }
                : {}),
              ...(policy.validity.enforced
                ? { validity: policy.validity.declared }
                : {}),
            }
          : {
              passThreshold: evalPassCriterionFraction(policy.passCriterion),
              ...(policy.iterationRule.kind === "caseCountWithFloor"
                ? { minimumIterations: policy.iterationRule.minimumIterations }
                : {}),
            };
      const plan = planEvalGradingPolicyEdit(policy, edit);
      expect(plan.ok, JSON.stringify(source)).toBe(true);
      if (!plan.ok) continue;
      expect(plan.settings, JSON.stringify(source)).toStrictEqual({});
      expect([...plan.changed], JSON.stringify(source)).toEqual([]);
    }
  });
});

describe("grading policy — the closed vocabularies", () => {
  it("origins are boundary metadata over the contracts that exist", () => {
    expect([...EVAL_GRADING_POLICY_ORIGINS]).toEqual([
      "suiteFile",
      "hostedPerCase",
      "hostedSuiteWide",
      "runReporting",
    ]);
  });

  it("no refusal code offers a scope conversion", () => {
    for (const refusal of EVAL_GRADING_POLICY_REFUSALS) {
      expect(refusal.toLowerCase()).not.toContain("scope");
      expect(refusal.toLowerCase()).not.toContain("upgrade");
      expect(refusal.toLowerCase()).not.toContain("migrat");
    }
  });

  it("the producer fallback threshold is the one every legacy producer spells", () => {
    expect(LEGACY_SUITE_WIDE_THRESHOLD_PERCENT).toBe(100);
  });

  it("every fixture row's expected policy validates", () => {
    for (const row of fixtures.normalization) {
      const parsed = evalGradingPolicySchema.safeParse(
        stripAnnotations(row.expected)
      );
      expect(parsed.success, row.__label).toBe(true);
    }
  });
});
