/**
 * Public projection of a run's VERDICT POLICY evidence (verdict policy v2).
 *
 * Extracted from `evals.ts` for the same reason as `eval-score-projection.ts`:
 * the route module is a large Hono app, and a test that re-implements the rule
 * proves only that it agrees with itself. What this boundary guards is the
 * decision a caller GATES on — a partially-valid decision published as a whole
 * one is how a gate reads a pass out of evidence the backend never produced.
 *
 * Two rules, both failing closed:
 *
 *  1. The decision is projected only when it validates against the canonical
 *     contract schema (`evalVerdictDecisionSchema`, the arithmetic-checking
 *     superset — not the structural JSON-Schema subset). A decision that does
 *     not validate is ABSENT, never partially trusted.
 *  2. `verdictPolicyVersion` and `verdictPolicyIntegrityError` survive
 *     independently of the summary: an operator must be able to tell "this run
 *     was decided under v2 and produced no readable summary" from "this run is
 *     a legacy percent-threshold run".
 *
 * Fields are OMITTED rather than nulled, so a legacy run's DTO is
 * byte-identical to what it was before v2 existed.
 */

import { z } from "zod";
import {
  evalSuiteFileValiditySchema,
  evalVerdictDecisionSchema,
  isEvalVerdictPolicyV2,
  EVAL_VERDICT_POLICY_VERSION,
} from "@mcpjam/sdk/contract";

/**
 * A suite's v2 defaults as stored, validated with the SAME shapes the suite
 * file declares them in: `repetitions` a positive integer, `passThreshold` a
 * fraction, `validity` the declared (not resolved) policy whose omitted fields
 * carry contract-defined meanings.
 *
 * Strict, so a field the backend adds without a contract change projects as
 * absent instead of leaking an unnamed shape to public callers.
 */
const suiteVerdictPolicyDefaultsSchema = z
  .object({
    repetitions: z.number().int().min(1),
    passThreshold: z.number().min(0).max(1),
    validity: evalSuiteFileValiditySchema.optional(),
  })
  .strict();

/**
 * Project the run's v2 verdict fields.
 *
 * The caller passes the run row; only the three v2 fields are read. A run
 * without `verdictPolicyVersion` is LEGACY and projects nothing at all — the
 * absence is the signal, and defaulting it to `2` would claim every historical
 * percent-threshold run was decided under a policy that did not exist.
 */
export function toRunVerdictProjection(run: {
  verdictPolicyVersion?: unknown;
  verdictSummary?: unknown;
  verdictPolicyIntegrityError?: unknown;
}): Record<string, unknown> {
  if (!isEvalVerdictPolicyV2(run.verdictPolicyVersion)) return {};

  const summary = evalVerdictDecisionSchema.safeParse(run.verdictSummary);
  return {
    verdictPolicyVersion: EVAL_VERDICT_POLICY_VERSION,
    ...(summary.success ? { verdictSummary: summary.data } : {}),
    ...(typeof run.verdictPolicyIntegrityError === "string" &&
    run.verdictPolicyIntegrityError.length > 0
      ? { verdictPolicyIntegrityError: run.verdictPolicyIntegrityError }
      : {}),
  };
}

/**
 * Project a SUITE's verdict policy: which policy its runs are decided under,
 * and the defaults its cases inherit.
 *
 * A legacy suite projects nothing, for the same reason a legacy run does — its
 * runs are graded by a suite-wide percent against a different trial resolver,
 * and there is no fraction to report that would not be a reinterpretation of
 * that percent.
 *
 * The defaults are projected only as a whole validated object: `repetitions`
 * without `passThreshold` is not a partial answer to "what will my case be
 * graded against", it is an unanswerable one.
 */
export function toSuiteVerdictPolicyDto(suite: {
  verdictPolicyVersion?: unknown;
  verdictPolicyDefaults?: unknown;
}): Record<string, unknown> {
  if (!isEvalVerdictPolicyV2(suite.verdictPolicyVersion)) return {};

  const defaults = suiteVerdictPolicyDefaultsSchema.safeParse(
    suite.verdictPolicyDefaults
  );
  return {
    verdictPolicyVersion: EVAL_VERDICT_POLICY_VERSION,
    ...(defaults.success ? { verdictPolicyDefaults: defaults.data } : {}),
  };
}
