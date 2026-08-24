/**
 * Loader + trial-derivation helper for the shared verdict-policy fixtures.
 *
 * A plain module, not a test file: both `contract-verdict-policy.test.ts` (zod)
 * and `eval-verdict-policy-schema-json.test.ts` (ajv) read the same rows, and
 * importing one test file from another would re-register its `describe`s in the
 * importer and report every case twice.
 *
 * The strip rule lives here for the reason the fixture's `__readme` spells out:
 * every object in this contract is closed, so a payload still carrying `__label`
 * would be rejected for the wrong reason — turning an accept row into a false
 * failure and a reject row into a false success.
 *
 * {@link deriveCaseCounts} is FIXTURE DERIVATION, not a shipped aggregator. It
 * exists so the `aggregation` cohort's expected output is proven self-consistent
 * with the trial list it claims to summarize, rather than being a hand-typed
 * number nobody re-checks. B4-W1 deliberately ships no runtime aggregation: the
 * producer is a later wave, and when it arrives it is checked against these same
 * rows.
 */

import fixtures from "../fixtures/eval-verdict-policy-parity-fixtures.json" with { type: "json" };
import type { IterationStatus } from "../../src/contract/chain.js";
import type { EvalTrialExclusionReason } from "../../src/contract/verdict-policy.js";

export type VerdictPolicyFixtureKind = "decision" | "case" | "rate" | "policy";

export type VerdictPolicyFixtureRow = Record<string, unknown> & {
  __kind: VerdictPolicyFixtureKind;
  __label: string;
  __why?: string;
  /**
   * Whether the GENERATED JSON Schema must reject this row too, or whether it
   * is a cross-field rule only the zod validator can express.
   */
  __structural?: boolean;
};

/** One trial as the aggregation cohort describes it. */
export type FixtureTrial = {
  status: IterationStatus;
  taskVerdict?: "passed" | "failed";
  evaluatorError?: boolean;
};

export type AggregationFixtureRow = {
  __label: string;
  __why?: string;
  input: {
    caseId: string;
    configuredTrials: number;
    effectivePassThreshold: number;
    trials: FixtureTrial[];
  };
  expected: Record<string, unknown>;
};

export type VerdictPolicyFixtures = {
  __readme: string;
  accept: VerdictPolicyFixtureRow[];
  reject: VerdictPolicyFixtureRow[];
  roundTrip: VerdictPolicyFixtureRow[];
  aggregation: AggregationFixtureRow[];
};

export const verdictPolicyFixtures =
  fixtures as unknown as VerdictPolicyFixtures;

/** Strip every `__`-prefixed annotation, recursively. */
export function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key.startsWith("__")) continue;
      out[key] = stripAnnotations(entry);
    }
    return out as unknown as T;
  }
  return value;
}

/** The validator-ready payload for one fixture row. */
export function verdictPolicyPayload(row: {
  __kind: VerdictPolicyFixtureKind;
}): unknown {
  return stripAnnotations(row);
}

/** Every row of one kind, in fixture order. */
export function rowsOfKind(
  cohort: VerdictPolicyFixtureRow[],
  kind: VerdictPolicyFixtureKind
): VerdictPolicyFixtureRow[] {
  return cohort.filter((row) => row.__kind === kind);
}

/** The one row whose `__label` starts with `labelPrefix`, or a loud failure. */
export function findFixture(
  cohort: VerdictPolicyFixtureRow[],
  labelPrefix: string
): VerdictPolicyFixtureRow {
  const row = cohort.find((entry) => entry.__label.startsWith(labelPrefix));
  if (!row) {
    throw new Error(`missing verdict-policy fixture "${labelPrefix}"`);
  }
  return row;
}

/**
 * Statuses whose trials are NOT in an attempted denominator.
 *
 * Three distinct reasons for the same exclusion, and the differences are the
 * rule:
 *
 *   - `pending` — never started.
 *   - `skipped` — deliberately not run, so counting it as an incomplete attempt
 *     would report a run as unfinished for work nobody asked for.
 *   - `cancelled` — started, then WITHDRAWN. The trial's outcome was taken away
 *     by a human or a shutdown, so it cannot be evidence either way, and
 *     leaving it in the completion denominator would let cancelling a run
 *     manufacture an inconclusive verdict about the server.
 *
 * `running` is deliberately NOT here: a running trial has begun, and a mid-run
 * roll-up that called it "never attempted" would report full completion of a run
 * that is still going. `setup_failed` and `timed_out` are not here either — both
 * consumed an attempt and never completed, which is exactly what the completion
 * rate is meant to notice.
 */
const NOT_ATTEMPTED: readonly IterationStatus[] = [
  "pending",
  "skipped",
  "cancelled",
];

const EXCLUSION_OF_STATUS: Record<string, EvalTrialExclusionReason> = {
  pending: "notTerminal",
  running: "notTerminal",
  skipped: "skipped",
  setup_failed: "setupFailed",
  cancelled: "cancelled",
  timed_out: "timedOut",
  failed: "executionFailed",
};

function isAttempted(trial: FixtureTrial): boolean {
  return !NOT_ATTEMPTED.includes(trial.status);
}

function isEligible(trial: FixtureTrial): boolean {
  return (
    trial.status === "completed" &&
    trial.taskVerdict !== undefined &&
    trial.evaluatorError !== true
  );
}

export type DerivedCaseCounts = {
  attempted: number;
  eligible: number;
  passed: number;
  failed: number;
  completed: number;
  evaluatorErrors: number;
  eligibilityExclusions: Partial<Record<EvalTrialExclusionReason, number>>;
  attemptExclusions: Partial<Record<EvalTrialExclusionReason, number>>;
};

/**
 * The counts a trial list implies, by the rules the fixture `__readme` pins.
 *
 * Two exclusion tallies, not one, because the trials removed from the
 * ELIGIBILITY denominator are not the ones removed from the ATTEMPTED
 * denominator: a `running` or `setup_failed` trial leaves eligibility while
 * staying in attempted, and a `cancelled` or `skipped` one leaves both.
 * Collapsing them would make a completion rate that silently forgives work that
 * failed.
 */
export function deriveCaseCounts(trials: FixtureTrial[]): DerivedCaseCounts {
  const attempted = trials.filter(isAttempted);
  const eligible = trials.filter(isEligible);
  const tally = (
    subset: FixtureTrial[]
  ): Partial<Record<EvalTrialExclusionReason, number>> => {
    const out: Partial<Record<EvalTrialExclusionReason, number>> = {};
    for (const trial of subset) {
      const reason: EvalTrialExclusionReason =
        trial.status === "completed"
          ? "evaluatorError"
          : (EXCLUSION_OF_STATUS[trial.status] ?? "executionFailed");
      out[reason] = (out[reason] ?? 0) + 1;
    }
    return out;
  };
  return {
    attempted: attempted.length,
    eligible: eligible.length,
    passed: eligible.filter((trial) => trial.taskVerdict === "passed").length,
    failed: eligible.filter((trial) => trial.taskVerdict === "failed").length,
    completed: attempted.filter((trial) => trial.status === "completed").length,
    evaluatorErrors: attempted.filter((trial) => trial.evaluatorError === true)
      .length,
    eligibilityExclusions: tally(trials.filter((trial) => !isEligible(trial))),
    attemptExclusions: tally(trials.filter((trial) => !isAttempted(trial))),
  };
}
