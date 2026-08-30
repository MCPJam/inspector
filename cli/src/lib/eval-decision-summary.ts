/**
 * The canonical eval run decision summary, for the CLI.
 *
 * ONE assembler, two ways of reaching it. `eval run --wait`, `eval gate` and
 * `eval compare` use it; `eval status` uses it; the JSON, JUnit and HTML
 * reporters all restate the object it returns. What none of them do any more is
 * compute a verdict of their own — the SDK's older per-case summary counted
 * iterations and called each one a case, which disagrees with the run's own
 * `EvalVerdictDecision` the moment a case has repetitions.
 *
 * ── Which path, and why ──────────────────────────────────────────────────────
 *
 * The API endpoint is the primary surface and this prefers it whenever the
 * command does not already hold the whole run. When a command DOES already hold
 * a complete iteration walk — `gate`, `compare` and `run --wait` all fetch every
 * page for their reports — assembling locally is both free and strictly more
 * complete: the endpoint answers one bounded page, so calling it there would
 * spend a round trip to get LESS of the run than is already in memory and mark
 * the result partial. Both paths call
 * `assembleEvalRunDecisionSummary`, so they produce the same bytes for the same
 * input; the choice is about how much of the run was read, never about how it
 * is interpreted.
 *
 * ── It never fails a command ─────────────────────────────────────────────────
 *
 * A decision summary is a diagnostic. An API that predates the endpoint falls
 * back to the older iteration resource, and a network hiccup answers worse;
 * neither says anything about the run being gated. So every path here resolves
 * to `undefined` rather than throwing, and the caller's existing verdict and
 * exit code are untouched.
 */

import {
  buildEvalRunDecisionSummary,
  readEvalRunDecisionSummary as readSharedEvalRunDecisionSummary,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk";
import type { PlatformApiClient, PlatformEvalRun } from "@mcpjam/sdk/platform";
import type { FetchedIterations } from "./eval-iterations.js";

/**
 * Assemble the summary from an iteration walk this command already performed.
 *
 * `iterations.complete` is carried through untouched: a walk that hit its page
 * bound produces a summary that says its diagnostics are partial, which is the
 * difference between "these are the failures" and "these are some of them".
 */
export function decisionSummaryFromIterations(input: {
  projectId: string;
  run: PlatformEvalRun;
  iterations: FetchedIterations;
}): EvalRunDecisionSummary {
  return buildEvalRunDecisionSummary({
    projectId: input.projectId,
    run: input.run,
    iterations: input.iterations.items,
    page: { complete: input.iterations.complete },
  });
}

/**
 * Read the summary for a run this command has not otherwise walked.
 *
 * Endpoint first. The fallback exists for API deployments that predate the
 * route — it fetches the same two reads the endpoint composes and hands them to
 * the SAME assembler, so an old deployment gets the same object rather than a
 * different opinion about the run.
 */
export async function readEvalRunDecisionSummary(
  client: Pick<
    PlatformApiClient,
    "getEvalRunDecisionSummary" | "listEvalRunIterations"
  >,
  signal: AbortSignal,
  projectId: string,
  run: PlatformEvalRun
): Promise<EvalRunDecisionSummary | undefined> {
  return readSharedEvalRunDecisionSummary(client, signal, projectId, run, {
    limit: 200,
  });
}
