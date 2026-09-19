/**
 * The words every surface uses for ONE grading policy.
 *
 * Browser-safe, no node-only deps, and nothing here decides anything: this is
 * the authoring and rendering vocabulary for the model in `./grading-policy.ts`
 * — the settings editor, the CLI's flag help, the MCP tool descriptions and the
 * docs all read from here so a threshold called one thing in the app is not
 * called something else in a terminal.
 *
 * ── Why a second labels module, beside `./decision-labels.ts` ────────────────
 *
 * `decision-labels.ts` renders what a run DECIDED — stages, reasons, verdicts,
 * the words a reader meets after the fact. This renders what a suite is
 * CONFIGURED with, which is a different job with a different audience: a
 * reader of a decision cannot change it, and a reader of a configuration is
 * about to. So the sentences here name the field the reader would edit and the
 * units it takes, and several of them are refusals rather than descriptions.
 *
 * They are also not registered in `DECISION_LABEL_VOCABULARIES`. That registry
 * is consumed by `openapi-decision-vocabularies.test.ts`, which walks the whole
 * OpenAPI document asserting that any enum overlapping a registered vocabulary
 * matches it exactly. Not one vocabulary below has a wire spelling — a criterion
 * scope, an iteration-rule kind and a policy origin are all facts a reader
 * DERIVES from the fields the API already reports, and deliberately so, because
 * adding a scope field to the wire would make the scope a thing a caller could
 * set. Registering them there would either redden that guard permanently or
 * invite somebody to give them wire spellings to satisfy it.
 * {@link SUITE_GRADING_LABEL_VOCABULARIES} is the local registry, and its
 * totality is asserted directly.
 *
 * ── The one thing these labels must never do ─────────────────────────────────
 *
 * No label below offers, names or implies a scope conversion, a policy version,
 * or an upgrade. `minimumAccuracy` and `passThreshold` differ in SCOPE as well
 * as units, so there is no wording under which "switch this suite to the other
 * one" is a threshold edit — and a label that read like one would be an
 * affordance for the exact mistake the contract refuses. What the words say
 * instead is which question each criterion answers, so a reader can tell that
 * two suites are measured differently without being told one is older.
 */

import {
  EVAL_GRADING_POLICY_ORIGINS,
  EVAL_GRADING_POLICY_REFUSALS,
  EVAL_RUN_REPORTING_PRODUCERS,
  EVAL_SUITE_WIDE_POPULATIONS,
  MAX_MINIMUM_ITERATIONS,
  type EvalGradingPolicyOrigin,
  type EvalGradingPolicyRefusal,
  type EvalIterationRule,
  type EvalPassCriterion,
  type EvalPassCriterionScope,
  type EvalRunReportingProducer,
  type EvalSuiteWidePopulation,
} from "./grading-policy.js";

// ── the criterion ────────────────────────────────────────────────────────────
/**
 * What must pass, said as the question the criterion answers.
 *
 * Neither label carries a version, a date or the word "legacy". A suite-wide
 * threshold is not an older spelling of a per-case one — it asks a different
 * question of the same run, and a reader comparing two suites needs to know
 * WHICH question, not which came first. "Suite accuracy" is also the phrase
 * the percent field has always been labelled with in the app, so an existing
 * suite's owner reads the same words they already knew.
 */
export const EVAL_PASS_CRITERION_SCOPE_LABELS = Object.freeze({
  perCase: "Per-case pass rate",
  suiteWide: "Suite accuracy",
} satisfies Record<EvalPassCriterionScope, string>);

/** One sentence on what the criterion measures, for a row's help text. */
export const EVAL_PASS_CRITERION_SCOPE_HINTS = Object.freeze({
  perCase:
    "Each case must pass at least this share of its own iterations. A case that falls short fails, whatever the rest of the suite did.",
  suiteWide:
    "One rate across the whole run must reach this percentage. Individual cases have no threshold of their own.",
} satisfies Record<EvalPassCriterionScope, string>);

/**
 * The units the criterion's number is typed in.
 *
 * Separate from the label because a form needs it beside the input and a
 * sentence needs it inline, and because the two scopes take different units —
 * which is the whole reason the scope travels with the threshold.
 */
export const EVAL_PASS_CRITERION_SCOPE_UNITS = Object.freeze({
  perCase: { suffix: "", range: "0–1", noun: "fraction" },
  suiteWide: { suffix: "%", range: "0–100", noun: "percentage" },
} satisfies Record<EvalPassCriterionScope, { suffix: string; range: string; noun: string }>);

/**
 * What a suite-wide rate is measured OVER.
 *
 * The long member name survives into the label. "Cases" alone reads as one row
 * per case per execution variant, which is what the per-case contract means by
 * a case aggregate and is not what this counts: a case fanned across two models
 * is ONE unit here. A reader who mistakes the two compares a 3 against a 15 and
 * concludes a suite regressed.
 */
export const EVAL_SUITE_WIDE_POPULATION_LABELS = Object.freeze({
  iterations: "iterations",
  casesIgnoringExecutionVariant: "cases, counting all models as one",
} satisfies Record<EvalSuiteWidePopulation, string>);

/** The population, spelled out for a reader who has to trust a number. */
export const EVAL_SUITE_WIDE_POPULATION_HINTS = Object.freeze({
  iterations:
    "Every iteration is one unit, so a 3-case suite run 5 times each is measured over 15.",
  casesIgnoringExecutionVariant:
    "Every case is one unit however many times or on however many models it ran, so a 3-case suite run 5 times each is measured over 3. A case fails if any of its iterations failed or timed out, and a case with no finished iteration is dropped from the rate entirely.",
} satisfies Record<EvalSuiteWidePopulation, string>);

/**
 * What an EMPTY population rates, said as a verdict rather than a number.
 *
 * Keyed by the rate itself because that is what the model carries, and the two
 * numbers are two different answers to "a run that measured nothing": `1` is
 * the hosted finalizer's vacuous pass, `0` is what the other two producers
 * give. Showing a reader the bare rate would have them read `0` as "0% passed"
 * rather than "a run with nothing in it does not pass".
 */
export const EVAL_EMPTY_POPULATION_RATE_LABELS = Object.freeze({
  0: "a run that measured nothing does not pass",
  1: "a run that measured nothing passes",
} satisfies Record<0 | 1, string>);

// ── how many times ───────────────────────────────────────────────────────────
/**
 * How many times each case runs, by rule.
 *
 * "Iterations per case" and "Minimum iterations per case" are one word apart
 * on purpose: the difference is a default that a case REPLACES versus a floor
 * that RAISES the case's own count, and the words a form uses have to survive
 * being read quickly. A case at 7 resolves to 7 under a floor of 3 and to 3
 * under a default of 3 — same number, opposite answers — so "minimum" is doing
 * real work and is never dropped for brevity.
 */
export const EVAL_ITERATION_RULE_LABELS = Object.freeze({
  defaultCount: "Iterations per case",
  caseCountWithFloor: "Minimum iterations per case",
} satisfies Record<EvalIterationRule["kind"], string>);

/** One sentence on what editing the count does to a case that set its own. */
export const EVAL_ITERATION_RULE_HINTS = Object.freeze({
  defaultCount:
    "The suite default. A case that sets its own count uses that instead.",
  caseCountWithFloor: `A floor, 1–${MAX_MINIMUM_ITERATIONS}: a case always runs at least this many times, and a case configured for more keeps its own count. Clearing it removes the floor.`,
} satisfies Record<EvalIterationRule["kind"], string>);

// ── validity ─────────────────────────────────────────────────────────────────
/**
 * Whether a run may conclude "we did not measure enough to judge this".
 *
 * `false` is not "validity is off" and not "this suite always decides". It is
 * that the phase does not run at all, so `inconclusive` is not among the
 * verdicts this suite's runs can reach — and a surface that showed such a suite
 * an inactive 80% completion floor would be describing a rule that has never
 * been applied to it.
 */
export const EVAL_GRADING_VALIDITY_LABELS = Object.freeze({
  enforced: "Evidence requirements",
  notEnforced: "No evidence requirements",
} satisfies Record<"enforced" | "notEnforced", string>);

export const EVAL_GRADING_VALIDITY_HINTS = Object.freeze({
  enforced:
    "A run that measured too little is inconclusive rather than passed or failed.",
  notEnforced:
    "Runs on this suite are always passed or failed; they are never inconclusive on evidence grounds.",
} satisfies Record<"enforced" | "notEnforced", string>);

/**
 * The declared validity members, in the order a form shows them.
 *
 * `minEligibleTrials` is last and its label says "at least", because omitting
 * it selects a STRICTER rule — every configured trial attempted plus at least
 * one gradeable — rather than no minimum. A form that rendered it as an empty
 * number field labelled "minimum" would read as "no minimum", which is
 * backwards.
 */
export const EVAL_GRADING_VALIDITY_FIELD_LABELS = Object.freeze({
  minCompletionRate: "Minimum completion rate",
  maxEvaluatorErrorRate: "Maximum evaluator error rate",
  minEligibleTrials: "Minimum gradeable iterations",
} satisfies Record<"minCompletionRate" | "maxEvaluatorErrorRate" | "minEligibleTrials", string>);

export const EVAL_GRADING_VALIDITY_FIELD_HINTS = Object.freeze({
  minCompletionRate:
    "Share of attempted iterations that must finish for the run to be decided.",
  maxEvaluatorErrorRate:
    "Share of iterations the evaluator may fail on before the run says nothing about the server.",
  minEligibleTrials:
    "Leave empty to require every configured iteration attempted and at least one gradeable — the stricter rule. A number relaxes that to a count.",
} satisfies Record<"minCompletionRate" | "maxEvaluatorErrorRate" | "minEligibleTrials", string>);

// ── where the policy was read from ───────────────────────────────────────────
/**
 * Which contract a resolved policy was read out of.
 *
 * Boundary metadata, shown only where a reader needs to know why a policy
 * cannot be edited here (a suite file is edited in the file; a reported run's
 * criterion travelled with the run and has no settings at all). Not a version,
 * not a product name, not a thing anybody selects.
 */
export const EVAL_GRADING_POLICY_ORIGIN_LABELS = Object.freeze({
  suiteFile: "from the suite file",
  hostedPerCase: "from this suite's settings",
  hostedSuiteWide: "from this suite's settings",
  runReporting: "recorded on the run",
} satisfies Record<EvalGradingPolicyOrigin, string>);

/**
 * Which summary produced a reported run's rate.
 *
 * Both are suite-wide percentages and they measure different populations, so
 * the same stored threshold decides a three-case suite run five times each
 * differently — 3 units against 15. The labels name the population rather than
 * the code path, because the population is the part that changes the answer.
 */
export const EVAL_RUN_REPORTING_PRODUCER_LABELS = Object.freeze({
  hosted: "measured over cases",
  localFallback: "measured over iterations",
} satisfies Record<EvalRunReportingProducer, string>);

// ── refusals ─────────────────────────────────────────────────────────────────
/**
 * Why an edit could not be made, in words a reader can act on.
 *
 * Every one names the operation that DOES exist, because a refusal that only
 * says no leaves the reader to guess — and the likeliest guess is the scope
 * conversion nothing here can do. None of these sentences offers one.
 */
export const EVAL_GRADING_POLICY_REFUSAL_LABELS = Object.freeze({
  iterationsNotRepresentable:
    "This suite sets a minimum iteration count per case, not a suite default. Change the minimum, or set the count on each case.",
  minimumIterationsNotRepresentable:
    "This suite sets a default iteration count that each case can override, not a minimum. Change the default, or set the count on the cases that need more.",
  validityNotEnforced:
    "Runs on this suite are always passed or failed, so there is nothing for evidence requirements to withhold. They apply only where a run can be inconclusive.",
  readOnlyPolicy:
    "This describes how one finished run was decided. It is not a setting, and changing it would not re-decide the run.",
} satisfies Record<EvalGradingPolicyRefusal, string>);

/**
 * Why a policy could not be READ — a fact about the deployment, not the suite.
 *
 * Kept beside the edit refusals because a surface renders them in the same
 * place, and kept distinct in wording because the two mean opposite things
 * about what the reader should do: an edit refusal says "that operation does
 * not exist here", and this says "we do not know this suite's policy at all".
 * Rendering the second as a scope would describe a threshold the suite does not
 * use.
 */
export const EVAL_GRADING_POLICY_READ_REFUSAL_LABELS = Object.freeze({
  deploymentDoesNotReportPolicy:
    "This deployment does not report which criterion decides the suite's runs, so its threshold cannot be read or edited from here.",
} satisfies Record<"deploymentDoesNotReportPolicy", string>);

// ── composed sentences ───────────────────────────────────────────────────────
/**
 * One criterion as a full sentence, units and population included.
 *
 * The one function here, and it exists because the three facts are only
 * meaningful together: a number without its units is ambiguous between the two
 * scopes, and a suite-wide percentage without its population is ambiguous by a
 * factor of the iteration count. Every surface that renders a threshold in
 * prose goes through this rather than concatenating its own.
 */
export function describeEvalPassCriterion(
  criterion: EvalPassCriterion
): string {
  if (criterion.scope === "perCase") {
    return `each case must pass ${criterion.threshold} of its own iterations`;
  }
  return `${criterion.thresholdPercent}% of ${
    EVAL_SUITE_WIDE_POPULATION_LABELS[criterion.population]
  } must pass`;
}

/**
 * One iteration rule as a full sentence.
 *
 * Says RAISED or REPLACED explicitly, because that is the difference between
 * the two rules and the word a reader needs in order to predict what happens
 * to a case that set its own count.
 */
export function describeEvalIterationRule(rule: EvalIterationRule): string {
  if (rule.kind === "defaultCount") {
    return `each case runs ${rule.iterations} times unless it sets its own count`;
  }
  if (rule.minimumIterations === null) {
    return "each case runs as many times as it configures, with no suite minimum";
  }
  return `each case runs at least ${rule.minimumIterations} times, and more if it configures more`;
}

/** Every vocabulary this module renders, for tests that assert totality. */
export const SUITE_GRADING_LABEL_VOCABULARIES = Object.freeze({
  passCriterionScopes: ["perCase", "suiteWide"] as const,
  suiteWidePopulations: EVAL_SUITE_WIDE_POPULATIONS,
  iterationRuleKinds: ["defaultCount", "caseCountWithFloor"] as const,
  policyOrigins: EVAL_GRADING_POLICY_ORIGINS,
  runReportingProducers: EVAL_RUN_REPORTING_PRODUCERS,
  editRefusals: EVAL_GRADING_POLICY_REFUSALS,
});
