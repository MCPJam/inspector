/**
 * Why an iteration never produced a measurement of the server under test.
 *
 * Twin of `mcpjam-backend/convex/lib/evalInfraError.ts` (pinned in that repo's
 * `convex/lib/mirrors.json`). Every trial records two separate facts: did OUR
 * infrastructure work, and did the agent succeed. `infraError` is the first
 * one, present only when the answer was "no". Such a trial is stored
 * `status: "failed"` + `result: "failed"`, left out of every pass rate (the
 * client's included), and refunded its eval fee. A turn timeout is never one.
 *
 * Classified by `server/services/evals/infra-error-classification.ts` from
 * producer-typed fields only.
 */
export const EVAL_INFRA_ERROR_CLASSES = [
  "provider_unavailable",
  "rate_limited",
  "capacity",
  "auth",
  "account_limit",
  "configuration",
  "sandbox",
] as const;
export type EvalInfraErrorClass = (typeof EVAL_INFRA_ERROR_CLASSES)[number];

/** Which of OUR layers failed. Never the customer's server. */
export const EVAL_INFRA_ERROR_LAYERS = [
  "model",
  "sandbox",
  "platform",
] as const;
export type EvalInfraErrorLayer = (typeof EVAL_INFRA_ERROR_LAYERS)[number];

export type EvalInfraError = {
  class: EvalInfraErrorClass;
  layer: EvalInfraErrorLayer;
  /** Whether the failure looked transient. Advisory: nothing retries today. */
  retryable: boolean;
  /** The producer's structured code (`provider_error`, `at_capacity`, …). */
  code?: string;
  /** The upstream HTTP status, when there was one. */
  httpStatus?: number;
};

/**
 * True when an iteration row records an infrastructure failure. Loose on
 * purpose, like the backend's: a class a newer writer added is still one.
 */
export function hasEvalInfraError(row: { infraError?: unknown }): boolean {
  const value = row.infraError;
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { class?: unknown }).class === "string"
  );
}
