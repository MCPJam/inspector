/**
 * Comparative gates: "is the compare run worse than the baseline?"
 *
 * Separate from `evaluateGates` because the question is different. A single-run
 * gate asks whether a run cleared an absolute bar; this asks whether two runs
 * measured the SAME THING and, if so, whether the second one got worse. The
 * first half of that is most of the work.
 *
 * --- The population rule ---
 *
 * Whole-run statistics compare populations, not runs. If the compare run added
 * a case, dropped one, re-graded one, changed a scenario's prompt, or simply
 * ran a case a different number of times, then its pass rate is measured over
 * a different population than the baseline's and the difference between them
 * is not a regression signal — it is an artefact of the change.
 *
 * So `passRateRegression` and `maximumP95LatencyIncreaseMs` are NON-GATEABLE
 * (⇒ incomplete ⇒ exit 3) unless ALL of these hold:
 *
 *   - no `new_case` / `removed_case` rows        (`caseSetChanged`)
 *   - no case's own scenario config changed      (`scenarioConfigChanged`)
 *   - the run-level evaluation config matches    (`evaluationConfigChanged`)
 *   - every shared case ran the same number of
 *     iterations on both sides                   (`iterationWeightingEqual`)
 *
 * The last one is the quietest and the most dangerous: unequal weighting
 * silently reweights the whole-run totals, so a run that "improved" may only
 * have run its easy cases more often.
 *
 * DETERMINISTIC per-case regressions are exempt. They join per caseKey, so
 * they are still meaningful when the population changed around them: a case
 * that used to pass its gating tool-match and now does not, under the same
 * definition, regressed regardless of what happened to its neighbours.
 *
 * --- Integrity ---
 *
 * Both sides must have verified score evidence. `undefined` counts as invalid,
 * the same tri-state rule `evaluateGates` applies.
 */

import {
  assessPassRateRegression,
  DEFAULT_MIN_SAMPLE_SIZE,
  type RegressionAssessment,
} from "./compare-stats.js";
import type {
  GateInput,
  GatePolicy,
  GateReport,
  GateVerdict,
  ScoreIntegrity,
} from "./gates.js";

/** One deterministic gating scorer that flipped `passed: true` -> `false`. */
export type DeterministicScoreRegression = {
  caseKey: string;
  scorerId: string;
};

export type CompareGateInput = {
  base: GateInput;
  compare: GateInput;
  /**
   * Already filtered by the caller to rows that are gating, deterministic, and
   * graded under an UNCHANGED definition. A definition that changed did not
   * measure the same thing twice, so its flip is not a regression.
   */
  deterministicScoreRegressions: DeterministicScoreRegression[];
  /** Whether per-case score deltas were available at all. */
  scoreDeltasAvailable: boolean;
  /** Any `new_case` or `removed_case` row. */
  caseSetChanged: boolean;
  /** Any `cases[].configChanged` row — a scenario's own prompt/steps moved. */
  scenarioConfigChanged: boolean;
  /** Run-level `evaluationConfigHash` mismatch. */
  evaluationConfigChanged: boolean;
  /** For every shared caseKey, base and compare ran the same iteration count. */
  iterationWeightingEqual: boolean;
};

type PopulationProblem = { condition: string; explanation: string };

/**
 * Every way the two runs failed to measure the same population, named
 * individually — "not comparable" without saying why is an unactionable CI
 * message.
 */
function populationProblems(input: CompareGateInput): PopulationProblem[] {
  const problems: PopulationProblem[] = [];
  if (input.caseSetChanged) {
    problems.push({
      condition: "caseSetChanged",
      explanation: "a case was added or removed",
    });
  }
  if (input.scenarioConfigChanged) {
    problems.push({
      condition: "scenarioConfigChanged",
      explanation:
        "a case's scenario config changed (a changed prompt is a different " +
        "measurement even when the case key survives)",
    });
  }
  if (input.evaluationConfigChanged) {
    problems.push({
      condition: "evaluationConfigChanged",
      explanation: "the run-level evaluation config changed",
    });
  }
  if (!input.iterationWeightingEqual) {
    problems.push({
      condition: "iterationWeightingEqual",
      explanation:
        "a shared case ran a different number of iterations on each side, " +
        "which silently reweights the whole-run totals",
    });
  }
  return problems;
}

function populationMessage(problems: PopulationProblem[]): string {
  return (
    `the two runs do not cover the same population, so whole-run rates are ` +
    `not comparable: ` +
    problems
      .map((problem) => `${problem.condition} (${problem.explanation})`)
      .join("; ")
  );
}

/**
 * Combined integrity. Valid only when BOTH sides verified — a comparison is
 * only as trustworthy as its weaker side, and `undefined` is not "fine".
 */
function combinedIntegrity(
  base: ScoreIntegrity | undefined,
  compare: ScoreIntegrity | undefined
): { gateable: boolean; label: ScoreIntegrity | "unknown"; message: string } {
  const describe = (integrity: ScoreIntegrity | undefined): string =>
    integrity === undefined ? "no verdict" : integrity;
  if (base === "valid" && compare === "valid") {
    return { gateable: true, label: "valid", message: "" };
  }
  return {
    gateable: false,
    label: base === "invalid" || compare === "invalid" ? "invalid" : "unknown",
    message:
      `score evidence must verify on BOTH runs to compare them (base: ` +
      `${describe(base)}, compare: ${describe(compare)}); absent evidence is ` +
      `not valid evidence`,
  };
}

function passRateSample(input: GateInput) {
  return {
    passed: input.iterations.passed,
    total: input.iterations.total,
  };
}

function formatDelta(assessment: RegressionAssessment): string {
  return (
    `pass rate ${(assessment.delta >= 0 ? "+" : "")}` +
    `${assessment.delta.toFixed(4)} ` +
    `(95% CI ${assessment.lower.toFixed(4)} to ${assessment.upper.toFixed(4)})`
  );
}

/**
 * Evaluate the comparative half of a gate policy.
 *
 * Outcome folding is IDENTICAL to `evaluateGates`: a broken policy outranks a
 * failure, which outranks an undecidable gate. A run that both regressed and
 * had one undecidable gate DID regress, and reporting "incomplete" would bury
 * that.
 */
export function evaluateCompareGates(
  input: CompareGateInput,
  policy: GatePolicy
): GateReport {
  const verdicts: GateVerdict[] = [];
  const problems = populationProblems(input);
  const comparablePopulation = problems.length === 0;
  const integrity = combinedIntegrity(
    input.base.scoreIntegrity,
    input.compare.scoreIntegrity
  );

  // ── deterministic regressions. Exempt from the population rule: these join
  // per caseKey, so a case that regressed under an unchanged definition
  // regressed no matter what happened to the cases around it.
  if (policy.noDeterministicRegressions) {
    const gate = "noDeterministicRegressions";
    if (!integrity.gateable) {
      verdicts.push({ gate, status: "non_gateable", message: integrity.message });
    } else if (!input.scoreDeltasAvailable) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message:
          "this comparison carries no per-case score deltas, so a " +
          "deterministic regression cannot be identified",
      });
    } else {
      const regressions = input.deterministicScoreRegressions;
      verdicts.push({
        gate,
        status: regressions.length === 0 ? "passed" : "failed",
        message:
          regressions.length === 0
            ? "no deterministic gating scorer regressed"
            : `${regressions.length} deterministic gating regression(s): ` +
              regressions
                .map(
                  (regression) =>
                    `${regression.caseKey}/${regression.scorerId}`
                )
                .join(", "),
        observed: regressions.length,
      });
    }
  }

  // ── statistical pass-rate regression. Whole-run, so the population rule
  // applies in full.
  if (policy.passRateRegression !== undefined) {
    const gate = "passRateRegression";
    if (!comparablePopulation) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: populationMessage(problems),
      });
    } else {
      const assessment = assessPassRateRegression({
        base: passRateSample(input.base),
        compare: passRateSample(input.compare),
        // Floored at 1. `--min-sample-size 0` would otherwise let a
        // comparison of two EMPTY runs reach the statistic, come back
        // `no_regression`, and exit 0 — a green gate over nothing at all.
        minSampleSize: Math.max(
          1,
          policy.passRateRegression.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE
        ),
        minEffectSize: policy.passRateRegression.minEffectSize,
      });
      verdicts.push(
        assessment.verdict === "insufficient_data"
          ? {
              gate,
              status: "non_gateable",
              message: assessment.reason ?? "insufficient sample",
              observed: assessment.delta,
            }
          : {
              gate,
              status:
                assessment.verdict === "regression" ? "failed" : "passed",
              message: formatDelta(assessment),
              observed: assessment.delta,
            }
      );
    }
  }

  // ── p95 latency increase. Whole-run, so the population rule applies.
  if (policy.maximumP95LatencyIncreaseMs !== undefined) {
    const gate = "maximumP95LatencyIncreaseMs";
    const threshold = policy.maximumP95LatencyIncreaseMs;
    const basePercentile = input.base.totals?.e2eP95Ms;
    const comparePercentile = input.compare.totals?.e2eP95Ms;
    if (!comparablePopulation) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message: populationMessage(problems),
        threshold,
      });
    } else if (
      basePercentile === undefined ||
      comparePercentile === undefined
    ) {
      verdicts.push({
        gate,
        status: "non_gateable",
        message:
          `no p95 latency on ${basePercentile === undefined ? "the base" : "the compare"} ` +
          `run, so an increase cannot be measured`,
        threshold,
      });
    } else {
      const increase = comparePercentile - basePercentile;
      verdicts.push({
        gate,
        status: increase <= threshold ? "passed" : "failed",
        message:
          `p95 e2e latency ${basePercentile}ms -> ${comparePercentile}ms ` +
          `(${increase >= 0 ? "+" : ""}${increase}ms)`,
        observed: increase,
        threshold,
      });
    }
  }

  return {
    outcome: verdicts.some((verdict) => verdict.status === "usage_error")
      ? "usage_error"
      : verdicts.some((verdict) => verdict.status === "failed")
        ? "failed"
        : verdicts.some((verdict) => verdict.status === "non_gateable")
          ? "incomplete"
          : "passed",
    verdicts,
    scoreIntegrity: integrity.label,
  };
}
