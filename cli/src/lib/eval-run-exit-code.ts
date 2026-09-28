import {
  isNonVerdictRunResult,
  isNonVerdictRunStatus,
} from "./eval-gate-exit-code.js";

/**
 * Exit code for `mcpjam cloud eval run --wait`.
 *
 * `eval run` (unlike `eval gate`) is not a gate — by default it launches and
 * reports, and a run that finished having FAILED its cases still exits 0.
 * `--wait` is different: a caller who asked this process to sit and watch a
 * run to completion is asking it to tell them how the run went, and "how did
 * it go" has six honest answers, not two.
 *
 * ```text
 *   0 — every waited run passed, unanimously, and (when a report was
 *       requested) every report was assembled cleanly.
 *   1 — a run COMPLETED with result: "failed". THE ONLY PRODUCER OF 1.
 *       Nothing else may ever report this code — see the doctrine below.
 *   2 — usage error (bad flags, `--reporter` without `--wait`, an invalid
 *       suite file). Thrown by Commander or by suite-file validation, never
 *       produced by this module — see `SUITE_FILE_RUN_INVALID_EXIT_CODE`.
 *   3 — auth failed: no credential, or the platform said UNAUTHORIZED /
 *       FORBIDDEN / OAUTH_REQUIRED, at launch OR mid-poll (a token that
 *       expired during a long wait). Zero-credit guarantee: reached before
 *       any run started, or a credential that stopped being valid partway
 *       through observing runs that were already paid for.
 *   4 — connection/setup failed before evaluation: a launch the CLI itself
 *       observed fail for a reason that is not auth and not "the suite file
 *       was invalid" (network, timeout, rate limit, an unrecognized launch
 *       error, a partial or wholly-failed fan-out), or a local `--out`
 *       write failure.
 *   5 — no valid verdict: inconclusive, a null/unrecognized result, a run
 *       whose own STATUS is failed/cancelled/timed_out, a wait that hit its
 *       deadline with the run still non-terminal, a mid-poll failure that
 *       was not auth-shaped, or a report that could not be assembled
 *       (iteration fetch failed, or the walk did not complete).
 * ```
 *
 * ## A run held for its judge is not a status this module ever sees
 *
 * `grading` — every trial finished, the run waiting for its gating judge — is
 * not in `TERMINAL_RUN_STATUSES` and never reaches `NON_VERDICT_STATUSES`.
 * `--wait` therefore keeps polling through it, and a wait that runs out with
 * the run still held is the "deadline with a non-terminal run" case above:
 * exit 5, never 1. A judge that has not answered is an absence of verdict, and
 * reporting one as a regression is the exact failure the doctrine below exists
 * to prevent.
 *
 * ## No infrastructure condition may ever map to 1
 *
 * Copied verbatim from `eval-gate-exit-code.ts`, because it is the one rule
 * that matters more than the others: a CI job that fails a release because a
 * network call flaked, and reports it as "the server regressed", trains
 * people to ignore the gate. Every non-verdict failure in this module — auth,
 * connection, timeout, an execution crash, an unmeasurable run — lands on 3,
 * 4, or 5. Only a run that reached `status: "completed"` with
 * `result: "failed"` may ever produce 1.
 *
 * ## Severity order: 1 > 3 > 4 > 5 > 0
 *
 * A launch can fan out to several targets, so the exit code is a worst-of
 * merge over every started run plus every wait/report failure. The order is
 * not arbitrary:
 *
 * - **1 first.** A real verdict failure is never masked by a sibling's
 *   infrastructure noise. Nothing but a verdict produces 1, and nothing
 *   hides a verdict's 1 — one invariant, easy to test.
 * - **3 beats 4.** A credential failure poisons every other observation (a
 *   mid-poll 401 may be *why* siblings show no verdict) and is prerequisite
 *   to fixing anything else.
 * - **4 beats 5.** A definite CLI-observed setup defect ("target 2 never
 *   launched: host offline") is more actionable than an absence ("no verdict
 *   observed"), and 5-conditions are frequently downstream of the
 *   4-condition.
 * - **0 only when unanimous** — every run passed, and, when a report was
 *   requested, every report was assembled.
 *
 * Structural precedent: `conformanceSuiteExitCode` in
 * `cli/src/lib/conformance-exit-code.ts` (failure outranks incomplete).
 *
 * ## `eval gate` keeps its four codes — deliberately
 *
 * `eval gate` (`eval-gate-exit-code.ts`) is untouched by this module and
 * keeps its four-code contract (0/1/2/3, where 3 = incomplete/non-gateable)
 * in v1. That is not an oversight: `gate`'s exit 3 means "incomplete", and
 * remapping it to a six-code scheme would invert retry-on-3 pipelines that
 * already treat 3 as safe to retry. A six-code migration for `gate` is
 * deferred behind a future explicit opt-in flag. Two undocumented exit-code
 * contracts must never coexist — this doc block and the CLI docs
 * (`docs/cli/reference.mdx`, `docs/cli/ci.mdx`) are the checked-in record of
 * both, and `gate`'s own doc block is the record of its exception.
 *
 * ## `billing_limit_reached` → 4, not 3
 *
 * The PRD's "3 auth failed (before work, zero credits)" is a guarantee
 * *about* code 3 — no work was done, no credits were burned — not a claim
 * that running out of credits is an auth failure. Entitlement/billing is a
 * setup failure the CLI observed before evaluation, so it maps to 4 through
 * the same "else" bucket as every other non-auth, non-invalid launch error
 * (network, timeout, rate limit, an error code this CLI has never seen).
 *
 * This holds even when the v1 API's own wire mapping obscures it: the
 * public error union has no billing member, so the server collapses
 * `BILLING_LIMIT_REACHED` onto the wire code `FORBIDDEN` — indistinguishable
 * from a real credential rejection by code alone. The original reason
 * survives in `details.code`, and `classifyLaunchErrorExitCode` checks it
 * BEFORE the auth-shaped set, so a disguised billing failure still reads as
 * 4, never 3.
 *
 * ## `status: "failed"` → 5, not 4
 *
 * From the CLI's vantage point, "setup failed before evaluation" and
 * "crashed mid-run" are indistinguishable in the run record: both surface as
 * `status: "failed"`. This initiative's attribution doctrine forbids
 * manufacturing the more specific claim — a measurable-and-wrong signal is
 * worse than an unmeasured one — so `status: "failed"` maps to 5 (no valid
 * verdict), never to 4 (a condition this module reserves for failures the
 * CLI itself observed pre-evaluation: a launch rejection, a wait-phase
 * network error, a local `--out` write failure). If the platform later
 * distinguishes setup-abort from mid-run crash, refining `status: "failed"`
 * to 4 is a SECOND behavior change, not a bugfix of this one — track it
 * separately when that distinction ships.
 *
 * ## Migration note
 *
 * `eval run --wait` shipped 2026-08-23 with the legacy two-outcome exit
 * contract (0 launch-and-waited-fine, 1 launch-or-completion problem). This
 * module replaces that with the six-code contract above as a direct flip —
 * no opt-in flag — because the compatibility window was days old. Default
 * (no `--wait`) behavior is untouched by this module and stays byte-
 * identical.
 *
 * ## The wait phase's own outer preamble is covered too
 *
 * Every PER-TARGET poll failure is captured and classified (see the
 * `errorCode` capture at the eval.ts call site). The one thing that can
 * fail from OUTSIDE that per-target handling — before the wait phase's
 * callback even starts — is `runPlatformOperation`'s own internal
 * `preflightCloudCredentials` recheck, so the eval.ts call site re-runs
 * that check explicitly first, exactly mirroring the launch-phase preflight
 * above: any resulting CliError with `exitCode !== 2` is remapped straight
 * to 3, unconditionally, not through {@link classifyWaitErrorExitCode} —
 * the only realistic failure at this point IS a credential, so there is no
 * "else" case to classify. The launch receipt is written before that
 * rethrow, for the same reason the timeout and `--out` paths write it
 * first: it is the only record of run ids already paid for.
 */

/** One waited run's outcome, as read off `PlatformEvalRun`. */
export type EvalRunWaitRunOutcome = {
  /** `PlatformEvalRun.status` — expected to be terminal (`--wait` polled to one). */
  status: string;
  /** `PlatformEvalRun.result`. */
  result: string | null | undefined;
  /**
   * True when a report was requested and this run's iteration fetch failed,
   * or its iteration walk did not complete. Never set when no report was
   * requested — an unread report is not a reporting failure.
   */
  reportingFailed?: boolean;
  /**
   * The wire error code of the iteration fetch failure, when it carried one
   * (a `PlatformApiError`). Classified the same way a mid-poll failure is —
   * auth-shaped means the credential died between the terminal poll and the
   * report fetch, not "no verdict observed" — so a token that expires in
   * that window still reads as 3, not 5.
   */
  reportingFailedErrorCode?: string;
};

/** One run this invocation could not observe to completion. */
export type EvalRunWaitErrorSummary = {
  runId: string;
  /** The wire error code, when the failure carried one (a `PlatformApiError`). */
  errorCode?: string;
};

export interface EvalRunWaitExitInput {
  /** The launch receipt's own `outcome` — `RunEvalSuiteResult.outcome`. */
  launchOutcome: "started" | "partial" | "failed";
  /** Every run this invocation waited on and observed to a terminal status. */
  runs: EvalRunWaitRunOutcome[];
  /** Every run this invocation could not observe (timeout, mid-poll failure). */
  waitErrors: EvalRunWaitErrorSummary[];
}

/** Severity order, most severe first. Anything absent from `codes` loses to 0. */
const SEVERITY_ORDER = [1, 3, 4, 5, 0] as const;

/**
 * Worst-of merge over raw exit codes, by {@link SEVERITY_ORDER}. Exported so
 * a caller that must fold in a code from OUTSIDE this module's own inputs —
 * e.g. a local `--out` write failure discovered after `evalRunWaitExitCode`
 * would otherwise have been the last word — can do it without re-deriving
 * the severity order, or worse, overwriting an already-computed verdict
 * code with a flat infrastructure one.
 */
export function worstOf(codes: number[]): number {
  for (const code of SEVERITY_ORDER) {
    if (codes.includes(code)) return code;
  }
  return 0;
}

/** One run's contribution to the merge — see the doc block for the mapping. */
function runExitCode(run: EvalRunWaitRunOutcome): number {
  const codes: number[] = [];
  if (isNonVerdictRunStatus(run.status)) {
    // status: "cancelled" | "timed_out" | "failed" — an execution state, not
    // a verdict. Deliberately 5, never 4: see "status: failed -> 5" above.
    codes.push(5);
  } else if (isNonVerdictRunResult(run.result)) {
    // result: "inconclusive" — the platform declined to decide.
    codes.push(5);
  } else if (run.result === "failed") {
    codes.push(1);
  } else if (run.result === "passed") {
    codes.push(0);
  } else {
    // null / unrecognized result on a status: "completed" run. Fail closed —
    // an unrecognized verdict is not a pass.
    codes.push(5);
  }
  if (run.reportingFailed) {
    // Same auth-vs-absence split as a mid-poll failure: a token that died
    // between the terminal poll and the report fetch is 3, not 5.
    codes.push(classifyWaitErrorExitCode(run.reportingFailedErrorCode));
  }
  return worstOf(codes);
}

/**
 * Worst-of merge across the launch outcome, every waited run, and every wait
 * failure. Returns 0 | 1 | 3 | 4 | 5 — never 2, which belongs to usage
 * errors and suite-file validation raised before this function is ever
 * called.
 */
export function evalRunWaitExitCode(input: EvalRunWaitExitInput): number {
  const codes: number[] = [];
  if (input.launchOutcome !== "started") {
    // A "partial" or wholly "failed" fan-out is a setup defect this CLI
    // observed directly — flat 4, not reclassified per failed target. See
    // the condition -> code table in the E1 charter.
    codes.push(4);
  }
  for (const run of input.runs) {
    codes.push(runExitCode(run));
  }
  for (const waitError of input.waitErrors) {
    codes.push(classifyWaitErrorExitCode(waitError.errorCode));
  }
  return worstOf(codes);
}

/** Wire codes that mean "the credential is no good", at launch or mid-poll. */
const AUTH_SHAPED_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "OAUTH_REQUIRED",
]);

/** Wire codes that mean "the request itself was invalid", not infrastructure. */
const INVALID_SHAPED_CODES = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "UNSUPPORTED",
]);

/**
 * Entitlement/billing codes the v1 API collapses onto the wire code
 * `FORBIDDEN` (`routes/v1/envelope.ts`'s `mapInternalCode`, backed by
 * `INTERNAL_TO_V1_CODE`: `BILLING_LIMIT_REACHED` -> `FORBIDDEN`) because the
 * public error union has no billing member. The original code survives
 * verbatim in `details.code` (`asBillingRouteError` in
 * `services/evals/recorder.ts` passes the Convex payload through as
 * `details`), which is the only way to tell "the credential is no good"
 * apart from "the credential is fine, the org is out of runway" once both
 * have flattened to the same wire code. Both keep the billing->4 reading —
 * `billing_feature_not_included` is a plan gap, not fixable by retrying the
 * same call with different credentials, exactly like the limit itself.
 */
const BILLING_SHAPED_DETAIL_CODES = new Set([
  "billing_limit_reached",
  "billing_feature_not_included",
]);

/** True when `details.code` names one of the billing-shaped codes above. */
function isBillingShapedDetail(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const inner = (details as { code?: unknown }).code;
  return typeof inner === "string" && BILLING_SHAPED_DETAIL_CODES.has(inner);
}

/**
 * Classify a launch-phase thrown platform error (a `CliError` whose
 * `exitCode` was not already 2 — see the eval.ts call site). `details` is
 * the wire error's `details` object, when it carried one; pass it through
 * even though most codes ignore it — it is what lets a billing failure
 * disguised as `FORBIDDEN` (see {@link BILLING_SHAPED_DETAIL_CODES}) still
 * read as 4, not 3, the same way the literal lowercase
 * `billing_limit_reached` code already does. Auth-shaped codes are
 * prerequisite to fixing anything else (3); invalid-shaped codes mean the
 * request itself was malformed, not infrastructure (2); everything else —
 * network, timeout, rate limit, an unrecognized code, and
 * `billing_limit_reached` — is a setup failure this CLI itself observed (4).
 * Unknown codes fail toward infra (4), never toward a verdict.
 */
export function classifyLaunchErrorExitCode(
  code: string | undefined,
  details?: unknown
): 2 | 3 | 4 {
  if (isBillingShapedDetail(details)) return 4;
  if (code !== undefined && AUTH_SHAPED_CODES.has(code)) return 3;
  if (code !== undefined && INVALID_SHAPED_CODES.has(code)) return 2;
  return 4;
}

/**
 * Classify one wait-phase failure (a deadline timeout, or a mid-poll
 * `getEvalRun` rejection). Auth-shaped codes mean the credential died mid-
 * wait (3, same as a launch-phase auth failure); everything else — a
 * deadline, a network error, an aborted global timeout — is "no valid
 * verdict observed" (5), never 4: the evaluation had already started, so
 * this is an absence of observation, not a setup defect the CLI can point
 * at.
 */
export function classifyWaitErrorExitCode(code: string | undefined): 3 | 5 {
  if (code !== undefined && AUTH_SHAPED_CODES.has(code)) return 3;
  return 5;
}
