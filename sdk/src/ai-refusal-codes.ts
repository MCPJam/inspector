/**
 * The refusal codes MCPJam answers with when an organization requires its own
 * provider keys for AI features ("Use your keys for all AI features"), and
 * whether each one lifts on its own.
 *
 * This is the one copy the SDK, the CLI and the inspector read. The SDK's
 * error describer, `mcpjam cloud eval run`'s exit codes and the inspector's
 * `shared/ai-execution-refusal.ts` all derive from it.
 *
 * The backend's `convex/lib/aiKeyPolicy.ts` is the source. The code list and
 * the retry table below match it word for word, comments included (only the
 * quote style differs). The backend pins its side in `convex/lib/mirrors.json`
 * (`ai-execution-refusal-codes` and `ai-refusal-retryable`), and the inspector
 * CI compares both lists and the table with the backend
 * (`scripts/check-ai-refusal-parity.mjs`). Change them in the backend first.
 *
 * Browser-safe: no imports.
 */

export const AI_EXECUTION_REFUSAL_CODES = [
  /** The org requires its own keys and this attempt would use another source. */
  "org_keys_required",
  /** Strict mode, no explicit selection, and no org default for this role. */
  "org_model_unconfigured",
  /** This operation has no org-credential adapter (yet) on this provider. */
  "org_runtime_unsupported",
  /** The data-owning organization could not be resolved, or disagreed. */
  "ai_scope_unresolved",
  /** The policy could not be read; fail closed. */
  "ai_key_policy_unavailable",
  /** The org provider rejected the credential (401/403). */
  "provider_auth_failed",
  /** The org provider is rate-limited or temporarily failing. */
  "provider_unavailable",
] as const;

/** One of the policy's own codes, {@link AI_EXECUTION_REFUSAL_CODES}. */
export type AiExecutionRefusalCode =
  (typeof AI_EXECUTION_REFUSAL_CODES)[number];

/**
 * Codes the policy reuses from model resolution, so they are not in
 * {@link AI_EXECUTION_REFUSAL_CODES}: the saved org connection is gone or has
 * no key (`credential_missing`), or the model can't do what the feature needs
 * or isn't available (the three model codes).
 */
export const AI_REUSED_REFUSAL_CODES = [
  "credential_missing",
  "capability_missing",
  "capability_unknown",
  "invalid_model",
] as const;

/**
 * Every code a policy-aware surface recognizes: the seven policy codes plus
 * the reused ones. The backend's `AiRefusalCode` is the same set.
 */
export type AiRefusalCode =
  AiExecutionRefusalCode | (typeof AI_REUSED_REFUSAL_CODES)[number];

/** Every {@link AiRefusalCode}, the policy's own codes first. */
export const AI_REFUSAL_CODES: readonly AiRefusalCode[] = [
  ...AI_EXECUTION_REFUSAL_CODES,
  ...AI_REUSED_REFUSAL_CODES,
];

const AI_EXECUTION_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(
  AI_EXECUTION_REFUSAL_CODES
);

const AI_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(AI_REFUSAL_CODES);

function isAiRefusalCode(value: string): value is AiRefusalCode {
  return AI_REFUSAL_CODE_SET.has(value);
}

/** Exactly one of {@link AI_EXECUTION_REFUSAL_CODES}, spelled as the wire spells it. */
export function isAiExecutionRefusalCode(
  value: unknown
): value is AiExecutionRefusalCode {
  return typeof value === "string" && AI_EXECUTION_REFUSAL_CODE_SET.has(value);
}

/**
 * `code` in canonical lowercase, when it is one of {@link AiRefusalCode}. A
 * stored row, a log line or an error envelope can carry the code in another
 * case or with stray whitespace.
 */
export function recognizedAiRefusalCode(
  code: string | null | undefined
): AiRefusalCode | undefined {
  if (typeof code !== "string") return undefined;
  const key = code.trim().toLowerCase();
  return isAiRefusalCode(key) ? key : undefined;
}

/**
 * Whether each refusal lifts on its own, as the backend classifies it. Only
 * two do: the policy could not be read (the backend fails closed), or the
 * org's provider is throttling or failing. Both arrive as 503 with
 * `isRetryable: true`. Every other code is permanent until someone changes
 * the organization's configuration or the request's model.
 *
 * The harness model proxy answers `ai_key_policy_unavailable` with
 * `x-should-retry: false` on its own replies: the proxy never re-sends a
 * call, and the coding agent behind it must not either. Everywhere else the
 * code stays temporary, as here.
 */
const RETRYABLE_BY_CODE: Readonly<Record<AiRefusalCode, boolean>> = {
  org_keys_required: false,
  org_model_unconfigured: false,
  org_runtime_unsupported: false,
  ai_scope_unresolved: false,
  ai_key_policy_unavailable: true,
  provider_auth_failed: false,
  provider_unavailable: true,
  credential_missing: false,
  capability_missing: false,
  capability_unknown: false,
  invalid_model: false,
};

/**
 * How a refusal should be handled.
 *
 * - `configuration`: permanent until someone changes the organization's
 *   configuration or the request's model. Never retried automatically, never
 *   paged, and never an account limit or a refund. The CLI exits 2.
 * - `temporary`: it lifts on its own, so trying again later can succeed. The
 *   CLI exits 4.
 */
export type AiRefusalClass = "configuration" | "temporary";

/** The {@link AiRefusalClass} of `code`. */
export function aiRefusalClass(code: AiRefusalCode): AiRefusalClass {
  return RETRYABLE_BY_CODE[code] ? "temporary" : "configuration";
}

/** The refusals that lift on their own (`temporary`). */
export const AI_RETRYABLE_REFUSAL_CODES: ReadonlySet<string> = new Set(
  AI_REFUSAL_CODES.filter((code) => aiRefusalClass(code) === "temporary")
);

/**
 * The refusals that need a configuration change (`configuration`). The same
 * set as the backend's `AI_CONFIGURATION_REFUSAL_CODES`.
 */
export const AI_CONFIGURATION_REFUSAL_CODES: ReadonlySet<string> = new Set(
  AI_REFUSAL_CODES.filter((code) => aiRefusalClass(code) === "configuration")
);
