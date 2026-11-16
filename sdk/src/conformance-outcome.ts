/**
 * The verdict vocabulary shared by every conformance suite.
 *
 * The tasks suite arrived at this model first, after a run where six of eight
 * checks silently skipped and the suite still reported success. The rule it
 * encodes is the whole point: **"did not run" must never read as "conformed"**.
 * Protocol, apps and OAuth now speak the same vocabulary, so a caller —
 * inspector, CLI, or a score — can reason about any suite the same way.
 *
 * This module is pure data reasoning: no MCP client, no transport, no Node
 * built-ins, so it is safe from the browser entry.
 */

import {
  isMissingInputCheck,
  missingInputForCheck,
} from "./conformance-input.js";

/**
 * Why a skipped check produced no verdict. The two are NOT interchangeable:
 *
 *   - `"not-applicable"` — the requirement cannot apply to THIS server, so
 *     nothing is left unverified. An era-gated check on the wrong protocol
 *     version, a capability the server never advertised, a transport-specific
 *     requirement on another transport. A run may still pass with these, and
 *     a score must leave them out of its denominator entirely.
 *   - `"could-not-run"` — the requirement DOES apply, but the run could not
 *     exercise it: a missing probe tool, an unreachable prerequisite, an
 *     opt-in the caller did not supply. The obligation is untested, so the
 *     run cannot claim conformance. The one exception is a check that only
 *     lacks a tool from setup (`isMissingInputCheck`): it is reported as
 *     needing input but does not hold the verdict back.
 */
export type ConformanceSkipReason = "not-applicable" | "could-not-run";

/**
 * A run's verdict.
 *
 *   - `"passed"` — every selected check either ran and passed, or was
 *     inapplicable to this server.
 *   - `"failed"` — at least one check produced a violation.
 *   - `"incomplete"` — nothing failed, but at least one selected check could
 *     not be run, so the run does not establish conformance.
 */
export type ConformanceRunOutcome = "passed" | "failed" | "incomplete";

/** The minimum a check must expose for the shared verdict logic to read it. */
export interface OutcomeCheckLike {
  id: string;
  status: "passed" | "failed" | "skipped";
  skipReason?: ConformanceSkipReason;
  error?: { message: string };
  details?: unknown;
}

/** Selected, applicable, and never exercised. */
export function isUnrunCheck(check: OutcomeCheckLike): boolean {
  return check.status === "skipped" && check.skipReason === "could-not-run";
}

/** Skipped because it could not apply here — nothing was left unverified. */
export function isInapplicableCheck(check: OutcomeCheckLike): boolean {
  return check.status === "skipped" && check.skipReason !== "could-not-run";
}

/**
 * The run's verdict, plus the reason when it is `incomplete`.
 *
 * `passed` requires that every SELECTED check either produced a verdict (it
 * ran, or it was inapplicable to this server) or only needs a tool from setup,
 * and that at least one check produced a verdict. A check that could not run
 * is neither a violation nor a pass, and collapsing it into "not failed" is
 * what let a two-of-eight run report success.
 */
export function decideConformanceOutcome(checks: OutcomeCheckLike[]): {
  outcome: ConformanceRunOutcome;
  incompleteReason?: string;
} {
  if (checks.some((check) => check.status === "failed")) {
    return { outcome: "failed" };
  }
  // A check that only lacks a tool from setup is the caller's gap, not the
  // server's: it shows as "Not run", costs no points, and does not hold the
  // verdict back. The score and the UI still report it as needing input.
  // A login is different: without it the server was never reached, so it
  // costs no points but still keeps the run from passing.
  const unrun = checks.filter(
    (check) =>
      isUnrunCheck(check) &&
      (!isMissingInputCheck(check) || missingInputForCheck(check) === "login"),
  );
  if (unrun.length === 0) {
    if (checks.length === 0) {
      return {
        outcome: "incomplete",
        incompleteReason:
          "no checks were selected, so this run establishes nothing",
      };
    }
    // Setup gaps alone don't block a verdict, but they can't make one either.
    if (checks.every(isMissingInputCheck)) {
      return {
        outcome: "incomplete",
        incompleteReason:
          "every selected check needs input from setup, so this run establishes nothing",
      };
    }
    return { outcome: "passed" };
  }
  const reasons = Array.from(
    new Set(unrun.map((check) => check.error?.message ?? "reason unavailable")),
  );
  return {
    outcome: "incomplete",
    incompleteReason: `${unrun.length} of ${
      checks.length
    } selected check(s) could not run, so this run does not establish conformance (${unrun
      .map((check) => check.id)
      .join(", ")}): ${reasons.join(" ")}`,
  };
}

/** The one-line tally every suite prints. */
export function buildOutcomeSummary(checks: OutcomeCheckLike[]): string {
  const passedCount = checks.filter((c) => c.status === "passed").length;
  const failedCount = checks.filter((c) => c.status === "failed").length;
  const unrunCount = checks.filter(isUnrunCheck).length;
  const inapplicableCount = checks.filter(isInapplicableCheck).length;
  return `${passedCount}/${checks.length} checks passed, ${failedCount} failed, ${unrunCount} could not run, ${inapplicableCount} not applicable`;
}
