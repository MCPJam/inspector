/**
 * G1: the words every surface uses for ONE grading policy.
 *
 * Two jobs. The first is totality — a vocabulary member added to
 * `grading-policy.ts` without words here would render a wire spelling in front
 * of somebody about to edit a threshold. The second is the property the plan
 * turns on: **no label offers, names or implies a policy version, an upgrade,
 * or a scope conversion.** A refusal that read like one would be an affordance
 * for the exact mistake the write adapter refuses, and a customer-facing
 * "legacy" would tell a suite's owner their configuration is obsolete when it
 * is simply measured differently.
 */

import { describe, expect, it } from "vitest";
import {
  EVAL_EMPTY_POPULATION_RATE_LABELS,
  EVAL_GRADING_POLICY_ORIGIN_LABELS,
  EVAL_GRADING_POLICY_READ_REFUSAL_LABELS,
  EVAL_GRADING_POLICY_REFUSAL_LABELS,
  EVAL_GRADING_VALIDITY_FIELD_HINTS,
  EVAL_GRADING_VALIDITY_FIELD_LABELS,
  EVAL_GRADING_VALIDITY_HINTS,
  EVAL_GRADING_VALIDITY_LABELS,
  EVAL_ITERATION_RULE_HINTS,
  EVAL_ITERATION_RULE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_HINTS,
  EVAL_PASS_CRITERION_SCOPE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_UNITS,
  EVAL_RUN_REPORTING_PRODUCER_LABELS,
  EVAL_SUITE_WIDE_POPULATION_HINTS,
  EVAL_SUITE_WIDE_POPULATION_LABELS,
  SUITE_GRADING_LABEL_VOCABULARIES,
  describeEvalIterationRule,
  describeEvalPassCriterion,
} from "../src/contract/suite-grading-labels.js";
import {
  DECISION_LABEL_VOCABULARIES,
  EVAL_GRADING_POLICY_ORIGINS,
  EVAL_GRADING_POLICY_REFUSALS,
  EVAL_RUN_REPORTING_PRODUCERS,
  EVAL_SUITE_WIDE_POPULATIONS,
} from "../src/contract/index.js";
import { GRADING_POLICY_READ_REFUSALS } from "../src/eval-grading-policy.js";

const total = (
  labels: Readonly<Record<string, unknown>>,
  vocabulary: readonly string[]
) => {
  expect(Object.keys(labels).sort()).toStrictEqual([...vocabulary].sort());
};

/** Every string a surface could put in front of a reader, flattened. */
function everyLabel(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (value && typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        walk(inner);
      }
    }
  };
  for (const map of [
    EVAL_PASS_CRITERION_SCOPE_LABELS,
    EVAL_PASS_CRITERION_SCOPE_HINTS,
    EVAL_PASS_CRITERION_SCOPE_UNITS,
    EVAL_SUITE_WIDE_POPULATION_LABELS,
    EVAL_SUITE_WIDE_POPULATION_HINTS,
    EVAL_EMPTY_POPULATION_RATE_LABELS,
    EVAL_ITERATION_RULE_LABELS,
    EVAL_ITERATION_RULE_HINTS,
    EVAL_GRADING_VALIDITY_LABELS,
    EVAL_GRADING_VALIDITY_HINTS,
    EVAL_GRADING_VALIDITY_FIELD_LABELS,
    EVAL_GRADING_VALIDITY_FIELD_HINTS,
    EVAL_GRADING_POLICY_ORIGIN_LABELS,
    EVAL_RUN_REPORTING_PRODUCER_LABELS,
    EVAL_GRADING_POLICY_REFUSAL_LABELS,
    EVAL_GRADING_POLICY_READ_REFUSAL_LABELS,
  ]) {
    walk(map);
  }
  return out;
}

describe("the labels are total over the vocabularies they render", () => {
  it("covers both criterion scopes, in every map that keys on them", () => {
    const scopes = SUITE_GRADING_LABEL_VOCABULARIES.passCriterionScopes;
    total(EVAL_PASS_CRITERION_SCOPE_LABELS, scopes);
    total(EVAL_PASS_CRITERION_SCOPE_HINTS, scopes);
    total(EVAL_PASS_CRITERION_SCOPE_UNITS, scopes);
  });

  it("covers both suite-wide populations", () => {
    total(EVAL_SUITE_WIDE_POPULATION_LABELS, EVAL_SUITE_WIDE_POPULATIONS);
    total(EVAL_SUITE_WIDE_POPULATION_HINTS, EVAL_SUITE_WIDE_POPULATIONS);
  });

  it("covers both empty-population rates", () => {
    // Keyed by the NUMBER, because that is what the model carries. Both are
    // present because they are two different answers, not a default and an
    // exception.
    expect(Object.keys(EVAL_EMPTY_POPULATION_RATE_LABELS).sort()).toStrictEqual(
      ["0", "1"]
    );
  });

  it("covers both iteration rules", () => {
    const kinds = SUITE_GRADING_LABEL_VOCABULARIES.iterationRuleKinds;
    total(EVAL_ITERATION_RULE_LABELS, kinds);
    total(EVAL_ITERATION_RULE_HINTS, kinds);
  });

  it("covers both validity states and all three declared members", () => {
    total(EVAL_GRADING_VALIDITY_LABELS, ["enforced", "notEnforced"]);
    total(EVAL_GRADING_VALIDITY_HINTS, ["enforced", "notEnforced"]);
    const members = [
      "minCompletionRate",
      "maxEvaluatorErrorRate",
      "minEligibleTrials",
    ];
    total(EVAL_GRADING_VALIDITY_FIELD_LABELS, members);
    total(EVAL_GRADING_VALIDITY_FIELD_HINTS, members);
  });

  it("covers every origin, producer and refusal", () => {
    total(EVAL_GRADING_POLICY_ORIGIN_LABELS, EVAL_GRADING_POLICY_ORIGINS);
    total(EVAL_RUN_REPORTING_PRODUCER_LABELS, EVAL_RUN_REPORTING_PRODUCERS);
    total(EVAL_GRADING_POLICY_REFUSAL_LABELS, EVAL_GRADING_POLICY_REFUSALS);
    // The READ refusal is a capability answer from the integration seam, not a
    // policy one, which is why it is a separate map with a separate source.
    total(
      EVAL_GRADING_POLICY_READ_REFUSAL_LABELS,
      GRADING_POLICY_READ_REFUSALS
    );
  });

  it("registers every vocabulary it renders", () => {
    expect(Object.keys(SUITE_GRADING_LABEL_VOCABULARIES).sort()).toStrictEqual([
      "editRefusals",
      "iterationRuleKinds",
      "passCriterionScopes",
      "policyOrigins",
      "runReportingProducers",
      "suiteWidePopulations",
    ]);
  });

  it("does NOT register itself in the decision-label registry", () => {
    // That registry is walked by `openapi-decision-vocabularies.test.ts`
    // against the whole OpenAPI document. None of these vocabularies has a
    // wire spelling — a scope and a rule kind are DERIVED from fields the API
    // already reports — so registering them would either redden that guard
    // permanently or invite somebody to give them wire spellings to satisfy
    // it, which would make the scope a thing a caller can set.
    for (const key of Object.keys(SUITE_GRADING_LABEL_VOCABULARIES)) {
      expect(DECISION_LABEL_VOCABULARIES).not.toHaveProperty(key);
    }
  });
});

describe("no label offers a version, an upgrade or a scope conversion", () => {
  it("never says legacy, v2, upgrade, migrate or deprecated", () => {
    // The plan's rule, asserted on the words themselves: there is no
    // customer-facing legacy/v2 selector and no version-upgrade terminology,
    // so a suite-wide suite's owner is told which question decides their runs
    // rather than that their configuration is old.
    const forbidden =
      /\b(legacy|v2|version\s*2|policy\s*2|upgrade|upgraded|upgrading|migrate|migrated|migration|deprecated|obsolete|old\s+policy|new\s+policy)\b/i;
    for (const label of everyLabel()) {
      expect(label, `label must not name a version: ${label}`).not.toMatch(
        forbidden
      );
    }
  });

  it("no refusal suggests converting the scope", () => {
    // A refusal is "this policy cannot express that operation". A sentence
    // proposing the conversion would read as a supported operation, and the
    // conversion is exactly what nothing in this contract can do.
    for (const message of Object.values(EVAL_GRADING_POLICY_REFUSAL_LABELS)) {
      expect(message).not.toMatch(
        /switch|convert|change the (policy|criterion|scope)|instead use (a|the) (per-case|suite-wide)/i
      );
    }
  });

  it("every edit refusal names an operation that DOES exist", () => {
    // A refusal that only says no leaves the reader to guess, and the
    // likeliest guess is the conversion above.
    expect(
      EVAL_GRADING_POLICY_REFUSAL_LABELS.iterationsNotRepresentable
    ).toMatch(/minimum/i);
    expect(
      EVAL_GRADING_POLICY_REFUSAL_LABELS.minimumIterationsNotRepresentable
    ).toMatch(/default/i);
    expect(EVAL_GRADING_POLICY_REFUSAL_LABELS.validityNotEnforced).toMatch(
      /inconclusive/i
    );
    expect(EVAL_GRADING_POLICY_REFUSAL_LABELS.readOnlyPolicy).toMatch(
      /not a setting/i
    );
  });

  it("the read refusal is about the DEPLOYMENT, not about the suite", () => {
    // Rendering it as a scope would describe a threshold the suite does not
    // use — a stored 0.9 fraction read as a 0.9% bar, or the reverse.
    const message =
      EVAL_GRADING_POLICY_READ_REFUSAL_LABELS.deploymentDoesNotReportPolicy;
    expect(message).toMatch(/deployment/i);
    expect(message).not.toMatch(/this suite (has|uses) no/i);
  });
});

describe("the labels keep the distinctions the model exists to keep", () => {
  it("the two scope labels are not two spellings of one thing", () => {
    expect(EVAL_PASS_CRITERION_SCOPE_LABELS.perCase).not.toBe(
      EVAL_PASS_CRITERION_SCOPE_LABELS.suiteWide
    );
    // And their units differ, which is the reason the scope travels with the
    // threshold at all.
    expect(EVAL_PASS_CRITERION_SCOPE_UNITS.perCase.range).toBe("0–1");
    expect(EVAL_PASS_CRITERION_SCOPE_UNITS.suiteWide.range).toBe("0–100");
    expect(EVAL_PASS_CRITERION_SCOPE_UNITS.suiteWide.suffix).toBe("%");
  });

  it("the case population label refuses the per-model reading", () => {
    // "cases" alone reads as one row per case per variant, which is what the
    // per-case contract means by a case aggregate and is 15 where this is 3.
    expect(
      EVAL_SUITE_WIDE_POPULATION_LABELS.casesIgnoringExecutionVariant
    ).toMatch(/models? as one/i);
    expect(
      EVAL_SUITE_WIDE_POPULATION_HINTS.casesIgnoringExecutionVariant
    ).toContain("3");
    expect(EVAL_SUITE_WIDE_POPULATION_HINTS.iterations).toContain("15");
  });

  it("the iteration labels keep minimum distinct from default", () => {
    // A case at 7 resolves to 7 under a floor of 3 and to 3 under a default of
    // 3. The word "minimum" is the only thing telling a reader which.
    expect(EVAL_ITERATION_RULE_LABELS.caseCountWithFloor).toMatch(/minimum/i);
    expect(EVAL_ITERATION_RULE_LABELS.defaultCount).not.toMatch(/minimum/i);
    expect(EVAL_ITERATION_RULE_HINTS.defaultCount).toMatch(/instead/i);
    expect(EVAL_ITERATION_RULE_HINTS.caseCountWithFloor).toMatch(/at least/i);
  });

  it("an omitted minimum-gradeable count is described as the STRICTER rule", () => {
    // An empty number field labelled "minimum" reads as "no minimum", which is
    // backwards: omission requires every configured trial attempted.
    expect(EVAL_GRADING_VALIDITY_FIELD_HINTS.minEligibleTrials).toMatch(
      /stricter/i
    );
    expect(EVAL_GRADING_VALIDITY_FIELD_HINTS.minEligibleTrials).toMatch(
      /relaxes/i
    );
  });

  it("not-enforced validity is described as a phase that does not run", () => {
    // Not "validity is off" and not "this suite always decides correctly":
    // `inconclusive` is not among the verdicts such a suite's runs can reach.
    expect(EVAL_GRADING_VALIDITY_HINTS.notEnforced).toMatch(/never/i);
    expect(EVAL_GRADING_VALIDITY_HINTS.notEnforced).toMatch(/inconclusive/i);
  });

  it("the empty-population labels are verdicts, not the bare rate", () => {
    expect(EVAL_EMPTY_POPULATION_RATE_LABELS[1]).toMatch(/passes/);
    expect(EVAL_EMPTY_POPULATION_RATE_LABELS[0]).toMatch(/does not pass/);
  });

  it("the two producers are distinguished by population, not by code path", () => {
    expect(EVAL_RUN_REPORTING_PRODUCER_LABELS.hosted).toMatch(/cases/i);
    expect(EVAL_RUN_REPORTING_PRODUCER_LABELS.localFallback).toMatch(
      /iterations/i
    );
  });

  it("both hosted origins read the same, because a reader edits both here", () => {
    // The origin exists to pick a WRITE shape, not to tell a reader which
    // storage their suite uses — and a surface that said so would be naming
    // the version this vocabulary refuses to name.
    expect(EVAL_GRADING_POLICY_ORIGIN_LABELS.hostedPerCase).toBe(
      EVAL_GRADING_POLICY_ORIGIN_LABELS.hostedSuiteWide
    );
  });
});

describe("the composed sentences carry every fact a number needs", () => {
  it("a per-case criterion says the case decides its own iterations", () => {
    expect(
      describeEvalPassCriterion({ scope: "perCase", threshold: 0.8 })
    ).toBe("each case must pass 0.8 of its own iterations");
  });

  it("a suite-wide criterion always names its population", () => {
    // A percentage without its population is ambiguous by a factor of the
    // iteration count, so the sentence cannot be built without it.
    expect(
      describeEvalPassCriterion({
        scope: "suiteWide",
        thresholdPercent: 90,
        population: "iterations",
        emptyPopulationRate: 1,
      })
    ).toBe("90% of iterations must pass");
    expect(
      describeEvalPassCriterion({
        scope: "suiteWide",
        thresholdPercent: 90,
        population: "casesIgnoringExecutionVariant",
        emptyPopulationRate: 0,
      })
    ).toBe("90% of cases, counting all models as one must pass");
  });

  it("the same threshold reads differently under the two scopes", () => {
    // The plan's counterexample, in words: 90 and 0.9 are not one number in
    // two units, and the two sentences must not be interchangeable.
    const suiteWide = describeEvalPassCriterion({
      scope: "suiteWide",
      thresholdPercent: 90,
      population: "iterations",
      emptyPopulationRate: 1,
    });
    const perCase = describeEvalPassCriterion({
      scope: "perCase",
      threshold: 0.9,
    });
    expect(suiteWide).not.toBe(perCase);
    expect(perCase).toMatch(/each case/);
    expect(suiteWide).not.toMatch(/each case/);
  });

  it("an iteration rule says RAISED or REPLACED, never just the number", () => {
    expect(
      describeEvalIterationRule({ kind: "defaultCount", iterations: 5 })
    ).toBe("each case runs 5 times unless it sets its own count");
    expect(
      describeEvalIterationRule({
        kind: "caseCountWithFloor",
        minimumIterations: 3,
      })
    ).toBe("each case runs at least 3 times, and more if it configures more");
  });

  it("a null floor is described as no minimum, not as 1", () => {
    // `null` is the suite's real state. Rendering it as "at least 1 time"
    // would describe a floor the suite does not have.
    const sentence = describeEvalIterationRule({
      kind: "caseCountWithFloor",
      minimumIterations: null,
    });
    expect(sentence).toMatch(/no suite minimum/);
    expect(sentence).not.toMatch(/at least 1/);
  });
});
