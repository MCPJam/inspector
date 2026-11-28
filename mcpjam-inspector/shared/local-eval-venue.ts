/**
 * What the server and the run sheet agree on about where an eval runs before
 * launch (`GET /api/mcp/local-harness/eval-venue`), and about the backend's
 * refusal of a run whose code evaluators or scripts need eval sandboxes.
 */

/** What the run sheet offers beside a client that can't run on this machine. */
export const LOCAL_EVAL_VENUE_FIXES = ["set-up", "retry", "choose-another"] as const;

export type LocalEvalVenueFix = (typeof LOCAL_EVAL_VENUE_FIXES)[number];

export type LocalEvalVenue =
  | { venue: "local" }
  | { venue: "cloud" }
  | { venue: "refused"; refusal: string; message: string; fix: LocalEvalVenueFix };

/** The backend refuses a run its code evaluators or scripts can't run in (EFTW-90). */
export const CODE_EVALUATORS_UNAVAILABLE = "EVAL_CODE_EVALUATORS_UNAVAILABLE";

/**
 * The refusal's rules that only a runner without eval sandboxes hits, so the
 * suite runs on MCPJam. Its other rules (grading off, or a Required evaluator
 * below Enforce) are suite settings MCPJam refuses the same way.
 */
export const CODE_EVALUATOR_RULES_FOR_MCPJAM: readonly string[] = [
  "local_run",
  "runner_without_sandboxes",
];
