/**
 * Detect the ENTITLEMENT WALL an external-account harness answers with instead
 * of failing.
 *
 * THE PROBLEM. A brokered harness that cannot run a model errors: the lease is
 * refused, the proxy rejects the request, something throws, and the turn is
 * visibly unsuccessful. An external-account harness has no such seam. Cursor
 * routes every request through the customer's own account, and when that
 * account's plan does not cover what was asked for, the CLI does not error —
 * it completes a perfectly normal turn whose entire assistant answer is
 * "Upgrade your plan to continue", with `end_turn` and no tools called
 * (observed verbatim during the harness spike).
 *
 * Left alone that is the worst possible shape: chat persists it as the
 * assistant's answer, and an eval SCORES it — a judge reading "Upgrade your
 * plan to continue" against a rubric produces a real-looking failure (or, for a
 * lenient rubric, a pass) for a turn where the model never ran at all. The
 * run's own result becomes evidence about a model that was never asked.
 *
 * THE RULE. Deliberately conservative, because a false positive is worse than a
 * miss: a miss records a bad turn, a false positive DELETES a real answer the
 * customer paid for. All three conditions must hold:
 *
 *   1. the turn's normalized assistant text EQUALS a known wall string — never
 *      `includes`, so an assistant discussing the phrase ("the CLI told me to
 *      upgrade my plan to continue") cannot be misread as hitting one;
 *   2. no tool call SUCCEEDED — a turn that actually did work is a real turn
 *      whatever it then said;
 *   3. the finish reason is a plain stop — not a length cut-off, not an error,
 *      not a tool-call pause.
 *
 * Normalization is whitespace only (trim + collapse runs). NOT case folding and
 * NOT punctuation stripping: those widen the match, and every widening is a
 * step toward discarding real output.
 */

/**
 * Wall strings observed VERBATIM from a real runtime.
 *
 * Only add a string that has actually been seen on the wire, quoted exactly.
 * A guessed variant is a rule that discards genuine assistant answers matching
 * a phrase nothing ever emitted — the exact-match discipline above is worth
 * nothing if the list it matches against is speculative.
 */
export const EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS: readonly string[] = [
  // cursor-agent 2026.08.31, plan-gated model, harness spike.
  "Upgrade your plan to continue",
];

/** Whitespace-only normalization — see the module note on why nothing more. */
function normalizeAssistantText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Did this turn hit an external-account entitlement wall?
 *
 * Callers must only ask this for a harness whose `modelAccess` is
 * `"external-account"`. A brokered harness cannot produce this shape (its
 * refusals are errors), so running the check there would be pure false-positive
 * surface.
 */
export function isExternalAccountPlanWallTurn(args: {
  /** The authoritative final assistant text (`res.text`), not the live deltas. */
  finalText: string | undefined | null;
  /** The turn's settled finish reason. */
  finishReason: string;
  /** How many tool calls returned a NON-error result this turn. */
  successfulToolCalls: number;
}): boolean {
  if (args.successfulToolCalls > 0) return false;
  if (args.finishReason !== "stop") return false;
  if (typeof args.finalText !== "string") return false;
  const normalized = normalizeAssistantText(args.finalText);
  return EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS.some(
    (wall) => normalized === normalizeAssistantText(wall),
  );
}

/**
 * The turn error a detected wall becomes.
 *
 * Phrased for the person who has to fix it, and it names the account rather
 * than MCPJam: nothing about this is an MCPJam limit, and a message that read
 * like one would send the reader to the wrong place entirely.
 */
export function externalAccountPlanWallError(displayName: string): Error {
  return new Error(
    `The ${displayName} harness answered with an account entitlement notice ` +
      "instead of running the model — the Cursor account behind this " +
      "environment's CURSOR_API_KEY does not cover the requested model. " +
      "Upgrade or change the plan on that Cursor account, then retry. " +
      "(Recorded as a failed turn on purpose: the model never ran, so there " +
      "is no answer here to persist or score.)",
  );
}
