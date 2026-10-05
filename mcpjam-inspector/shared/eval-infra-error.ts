/**
 * WHY AN ITERATION NEVER PRODUCED A MEASUREMENT OF THE SERVER UNDER TEST.
 *
 * Twin of `mcpjam-backend/convex/lib/evalInfraError.ts` (pinned in that repo's
 * `convex/lib/mirrors.json`). Every trial records two separate facts: did OUR
 * infrastructure work, and did the agent succeed. `infraError` is the first
 * one, present only when the answer was "no" — a model provider 5xx/overload,
 * a 429, a revoked key, an account admission limit, a sandbox that would not
 * come up, a worker that died. None of those says anything about the
 * customer's MCP server, so an iteration carrying it is:
 *
 *  - recorded as `status: "failed"` + `result: "failed"` (no new status — the
 *    v2 verdict already excludes `failed` as `executionFailed`);
 *  - excluded from every pass rate, the client's included;
 *  - refunded its eval unit fee. Model usage already incurred stays billed.
 *
 * A turn TIMEOUT is not infra: a turn budget is the user's ceiling.
 *
 * Classified by `server/services/evals/infra-error-classification.ts` from
 * STRUCTURED fields of a trusted producer only — never model or tool text, and
 * never a status the customer's own server returned.
 */
export const EVAL_INFRA_ERROR_CLASSES = [
  "provider_unavailable",
  "rate_limited",
  "capacity",
  "auth",
  "account_limit",
  "configuration",
  "sandbox",
  "worker_lost",
] as const;
export type EvalInfraErrorClass = (typeof EVAL_INFRA_ERROR_CLASSES)[number];

/** Which of OUR layers failed. Never the customer's server. */
export const EVAL_INFRA_ERROR_LAYERS = ["model", "sandbox", "platform"] as const;
export type EvalInfraErrorLayer = (typeof EVAL_INFRA_ERROR_LAYERS)[number];

export type EvalInfraError = {
  class: EvalInfraErrorClass;
  layer: EvalInfraErrorLayer;
  /** The classifier's transience call. Advisory; the retry gate is narrower. */
  retryable: boolean;
  /** The producer's structured code (`provider_overloaded`, `at_capacity`, …). */
  code?: string;
  /** The HTTP status the producer reported, when there was one. */
  httpStatus?: number;
};

/**
 * True when an iteration row records an infrastructure failure.
 *
 * LOOSE on purpose, exactly like the backend's `hasEvalInfraError`: a class a
 * newer writer added is still an infra row, and counting it against the
 * server because this reader is older would be the bug this field removes.
 */
export function hasEvalInfraError(row: { infraError?: unknown }): boolean {
  const value = row.infraError;
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { class?: unknown }).class === "string"
  );
}

/** Strict narrowing against this repo's vocabulary. */
export function isEvalInfraError(value: unknown): value is EvalInfraError {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.class === "string" &&
    (EVAL_INFRA_ERROR_CLASSES as readonly string[]).includes(record.class) &&
    typeof record.layer === "string" &&
    (EVAL_INFRA_ERROR_LAYERS as readonly string[]).includes(record.layer) &&
    typeof record.retryable === "boolean"
  );
}
