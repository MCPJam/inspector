/**
 * Public assembly of the canonical eval run decision summary.
 *
 * Separate from `evals.ts` for the same reason as `eval-stage-projection.ts`
 * and `eval-verdict-projection.ts`: the route module is a large Hono app, and a
 * test that re-implements the rule proves only that it agrees with itself.
 *
 * ── What this module does NOT do ─────────────────────────────────────────────
 *
 * It does not derive a verdict, count trials, read Convex documents, or touch
 * `metadata`. The summary itself is built by ONE function —
 * `assembleEvalRunDecisionSummary` in `@mcpjam/sdk/contract` — which the SDK's
 * own compatibility fallback also calls, so the API's answer and a client-side
 * assembly of the same inputs are the same bytes. Anything this file computed
 * for itself would be the second implementation the contract exists to remove.
 *
 * ── Why it takes DTOs, not documents ─────────────────────────────────────────
 *
 * The inputs are the run and iteration DTOs the route already produces, which
 * means every existing trust boundary has run first: `toRunVerdictProjection`
 * has refused a decision that does not validate, `toStageProjection` has
 * quarantined a stage chain that does not, and `toScoreProjection` has dropped
 * untrusted score evidence. Handing raw documents to the assembler would route
 * around all three and publish exactly the partially-valid evidence they exist
 * to withhold.
 */

import {
  assembleEvalRunDecisionSummary,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

/** Bounds shared with `GET …/iterations`, so one cursor pages both. */
export const DECISION_SUMMARY_DEFAULT_LIMIT = 50;
export const DECISION_SUMMARY_MAX_LIMIT = 200;

export function parseDecisionSummaryLimit(raw: string | undefined): number {
  return Math.min(
    Math.max(
      Number(raw ?? DECISION_SUMMARY_DEFAULT_LIMIT) ||
        DECISION_SUMMARY_DEFAULT_LIMIT,
      1
    ),
    DECISION_SUMMARY_MAX_LIMIT
  );
}

/**
 * Whether the diagnostics this page carries are the run's WHOLE non-passing
 * set.
 *
 * Both halves are load-bearing. A page reached through a cursor cannot be
 * complete however few rows follow it — the caller has already skipped some —
 * and a page the backend says is not the last one obviously is not. Getting
 * this wrong in the permissive direction lets a reader conclude "these are the
 * two cases that failed" from a sample, which is worse than being told the list
 * is partial.
 */
export function decisionSummaryPageIsComplete(input: {
  requestCursor: string | null;
  isDone: boolean;
}): boolean {
  return input.requestCursor === null && input.isDone === true;
}

/**
 * Build the response body from already-projected DTOs.
 *
 * `run` and `iterations` are typed as the structural inputs the contract
 * declares rather than as the route's own DTO types, which are inferred from
 * `toRunDto` / `toIterationDto` and therefore not nameable here. The compiler
 * still checks the fields the contract reads, which is the whole surface it
 * touches.
 */
export function buildEvalRunDecisionSummaryResponse(input: {
  projectId: string;
  run: Parameters<typeof assembleEvalRunDecisionSummary>[0]["run"];
  iterations: Parameters<
    typeof assembleEvalRunDecisionSummary
  >[0]["iterations"];
  page: { complete: boolean; nextCursor?: string };
}): EvalRunDecisionSummary {
  return assembleEvalRunDecisionSummary({
    projectId: input.projectId,
    run: input.run,
    iterations: input.iterations,
    page: input.page,
  });
}
