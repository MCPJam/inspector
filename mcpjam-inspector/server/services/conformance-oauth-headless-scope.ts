/**
 * Reconcile an OAuth conformance report against the exam scope that was
 * PINNED for it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A HEADLESS EXAM CANNOT REACH THE WHOLE SUITE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The OAuth suite was written for a debugger with a human in front of it. A
 * hosted benchmark has neither a human nor a consent screen, so a headless run
 * reaches the metadata, discovery and token-behaviour obligations and cannot
 * reach the authorization-code leg at all. That is a fact about the HARNESS,
 * and the report has to say so — because the alternative is a run that grades
 * a third of the suite and prints a number that looks like all of it.
 *
 * Two rules carry that, and they are the whole module:
 *
 *   1. `could-not-run`, NEVER `not-applicable`. `not-applicable` means the
 *      requirement cannot apply to THIS SERVER, so nothing was left
 *      unverified, and a score drops it from the denominator entirely
 *      (`conformance-outcome.ts` says so in as many words). A check the
 *      headless harness could not exercise is the opposite: the obligation
 *      applies and went untested. Collapsing the two is exactly how a
 *      two-of-eight run comes to report success.
 *
 *      The SDK's runner legitimately emits `not-applicable` for the
 *      authorization-code steps under `client_credentials` ("the
 *      client_credentials grant has no authorization-code leg") — true of the
 *      GRANT, and not true of a target that advertises the code flow. Inside
 *      the pinned scope those become `could-not-run` here.
 *
 *   2. ONE signal is allowed to mean "the target genuinely does not advertise
 *      this": the suite's own unauthenticated pre-flight. When the target
 *      serves an unauthenticated request instead of challenging, authorization
 *      is OPTIONAL in every MCP revision and the server has no authorization
 *      obligations to violate — the runner records that as a single skipped
 *      `request_without_token` step, and that is the marker read below. No
 *      other reason, and no message text, is interpreted.
 *
 * Checks OUTSIDE the pinned scope keep their verdicts verbatim and are marked
 * `pending`, which is the report's existing word for "reported but not graded
 * by the active profile" — they leave the denominator without leaving the
 * evidence.
 *
 * WHERE THE SCOPE COMES FROM. The list is the definition's
 * `oauthHeadlessCheckIds`, part of the hashed manifest, so the denominator a
 * scorecard is computed against is reproducible from the pins alone rather
 * than from whatever the harness happened to manage on the day.
 */

import {
  computeConformanceScore,
  type ConformanceReport,
  type ConformanceReportCase,
  type ConformanceReportGroup,
} from "@mcpjam/sdk";

/**
 * The runner's single marker for "this target does not require authorization".
 *
 * The pre-flight IS this step — the runner deliberately records one skipped
 * step rather than a manufactured list of every flow step that "would have"
 * run — which is what makes it safe to read structurally.
 */
const AUTH_PREFLIGHT_CASE_ID = "request_without_token";

const HEADLESS_UNREACHABLE_DETAIL =
  "The pinned headless exam could not exercise this check; the obligation applies and went untested.";

const AUTH_NOT_REQUIRED_DETAIL =
  "The target served an unauthenticated request instead of challenging, so it advertises no authorization obligations.";

export type HeadlessOAuthScopeResult = {
  report: ConformanceReport;
  /** In-scope ids the run left untested. Non-empty ⇒ the report is incomplete. */
  couldNotRun: string[];
  /** In-scope ids the target genuinely does not advertise. */
  notApplicable: string[];
  /** In-scope ids the run produced no case for at all. */
  missing: string[];
};

function isGraded(status: ConformanceReportCase["status"]): boolean {
  return status === "passed" || status === "failed";
}

function targetRequiresAuthorization(groups: ConformanceReportGroup[]): boolean {
  for (const group of groups) {
    for (const entry of group.cases) {
      if (
        entry.id === AUTH_PREFLIGHT_CASE_ID &&
        entry.status === "skipped" &&
        entry.skipReason === "not-applicable"
      ) {
        return false;
      }
    }
  }
  return true;
}

function untestedCase(
  entry: ConformanceReportCase,
  skipReason: "could-not-run" | "not-applicable",
  detail: string,
): ConformanceReportCase {
  const { pending: _pending, ...rest } = entry;
  return {
    ...rest,
    status: "skipped",
    skipReason,
    // The verdict logic builds its `incompleteReason` out of these messages,
    // so a reason the run already gave outranks the generic one.
    error: entry.error ?? detail,
  };
}

function synthesizedCase(
  id: string,
  skipReason: "could-not-run" | "not-applicable",
  detail: string,
): ConformanceReportCase {
  return {
    id,
    title: id,
    category: "oauth",
    status: "skipped",
    skipReason,
    durationMs: 0,
    error: detail,
  };
}

/**
 * Rewrite a finished OAuth report so its graded set is exactly the pinned
 * scope.
 *
 * Pure, and returns a new report: the caller persists what comes back, and the
 * SDK's own object is left alone so a surface that wants the raw run still has
 * it.
 *
 * An EMPTY scope is a no-op rather than a report with nothing in it. A
 * definition that pins no OAuth checks is saying the exam does not grade OAuth,
 * and blanking every case would turn "not part of this exam" into "the exam
 * found nothing" — which is a claim.
 */
export function reconcileHeadlessOAuthScope(args: {
  report: ConformanceReport;
  checkIds: readonly string[];
}): HeadlessOAuthScopeResult {
  const scope = new Set(args.checkIds);
  if (scope.size === 0) {
    return { report: args.report, couldNotRun: [], notApplicable: [], missing: [] };
  }

  const groups = args.report.groups ?? [];
  const requiresAuthorization = targetRequiresAuthorization(groups);
  const skipReason = requiresAuthorization ? "could-not-run" : "not-applicable";
  const detail = requiresAuthorization
    ? HEADLESS_UNREACHABLE_DETAIL
    : AUTH_NOT_REQUIRED_DETAIL;

  const seen = new Set<string>();
  const outOfScope: string[] = [];
  const couldNotRun: string[] = [];
  const notApplicable: string[] = [];

  const rewritten = groups.map((group) => ({
    ...group,
    cases: group.cases.map((entry) => {
      if (!scope.has(entry.id)) {
        outOfScope.push(entry.id);
        return { ...entry, pending: true };
      }
      seen.add(entry.id);
      if (isGraded(entry.status)) {
        const { pending: _pending, ...rest } = entry;
        return rest;
      }
      (requiresAuthorization ? couldNotRun : notApplicable).push(entry.id);
      return untestedCase(entry, skipReason, detail);
    }),
  }));

  const missing = args.checkIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    // The pinned exam runs ONE flow, so the report carries one group; a report
    // that somehow carries none still has to hold the missing checks, because
    // dropping them is how the denominator shrinks to whatever ran.
    const carrier = rewritten[0] ?? {
      id: "oauth-1",
      title: "OAuth Conformance",
      target: "",
      passed: false,
      durationMs: 0,
      cases: [],
    };
    carrier.cases = [
      ...carrier.cases,
      ...missing.map((id) => synthesizedCase(id, skipReason, detail)),
    ];
    if (rewritten.length === 0) rewritten.push(carrier);
    (requiresAuthorization ? couldNotRun : notApplicable).push(...missing);
  }

  const allCases = rewritten.flatMap((group) => group.cases);
  // `pendingCheckIds` is the report's existing mechanism for "reported, not
  // graded": the score partitions those out of the counts AND the verdict, so
  // the out-of-scope ids leave the denominator without a second code path.
  const score = computeConformanceScore(
    allCases.map((entry) => ({
      id: entry.id,
      status: entry.status,
      ...(entry.skipReason ? { skipReason: entry.skipReason } : {}),
      ...(entry.error ? { error: { message: entry.error } } : {}),
    })),
    args.report.score?.advisories ?? [],
    args.report.score?.protocolVersion,
    { pendingCheckIds: outOfScope },
  );

  // Rebuilt field by field rather than spread-and-patched: the SOURCE report
  // may carry an `incompleteReason` from a verdict this pass just replaced,
  // and a stale reason beside a fresh outcome reads as an explanation of it.
  const { incompleteReason: _stale, ...rest } = args.report;
  return {
    report: {
      ...rest,
      passed: score.outcome === "passed",
      outcome: score.outcome,
      ...(score.outcome === "incomplete"
        ? {
            incompleteReason: `${couldNotRun.length} pinned OAuth check(s) could not run headlessly (${couldNotRun.join(
              ", ",
            )}), so this run does not establish conformance`,
          }
        : {}),
      score,
      groups: rewritten,
    },
    couldNotRun,
    notApplicable,
    missing,
  };
}
