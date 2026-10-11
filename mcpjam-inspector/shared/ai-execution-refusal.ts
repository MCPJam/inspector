/**
 * The organization AI-key policy's refusal vocabulary ("Use your keys for all
 * AI features"), shared by the server and the browser.
 *
 * When an organization requires its own provider keys, every AI request must
 * run on an approved organization provider: MCPJam-provided (hosted) models,
 * personal local keys and keys exported for local execution are all refused.
 * The backend refuses with one of the codes below; its HTTP bodies are
 * `{ ok: false, code, error, isRetryable, remediation, organizationId? }`.
 *
 * The array region below is mirrored byte-for-byte (ignoring quote style and
 * whitespace) from the backend's own vocabulary file. Do not reword, reorder
 * or extend it here; change it there first.
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

export type AiExecutionRefusalCode =
  (typeof AI_EXECUTION_REFUSAL_CODES)[number];

const AI_EXECUTION_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(
  AI_EXECUTION_REFUSAL_CODES,
);

/** Exactly one of {@link AI_EXECUTION_REFUSAL_CODES}, spelled as the wire spells it. */
export function isAiExecutionRefusalCode(
  value: unknown,
): value is AiExecutionRefusalCode {
  return typeof value === "string" && AI_EXECUTION_REFUSAL_CODE_SET.has(value);
}

/**
 * The same seven codes, read tolerantly: a stored row or a log line can carry
 * the code in another case or with stray whitespace. True only for the codes
 * the org-key policy introduced, never for the reused ones
 * (`credential_missing`, `invalid_model`, …), which predate the policy.
 */
export function isOrgKeyPolicyRefusalCode(
  code: string | null | undefined,
): boolean {
  if (typeof code !== "string") return false;
  return AI_EXECUTION_REFUSAL_CODE_SET.has(code.trim().toLowerCase());
}

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
  | AiExecutionRefusalCode
  | (typeof AI_REUSED_REFUSAL_CODES)[number];

const AI_REFUSAL_CODES: readonly AiRefusalCode[] = [
  ...AI_EXECUTION_REFUSAL_CODES,
  ...AI_REUSED_REFUSAL_CODES,
];

const AI_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(AI_REFUSAL_CODES);

function isAiRefusalCode(key: string): key is AiRefusalCode {
  return AI_REFUSAL_CODE_SET.has(key);
}

/** `code` in canonical lowercase, when it is one of {@link AiRefusalCode}. */
export function recognizedAiRefusalCode(
  code: string | null | undefined,
): AiRefusalCode | undefined {
  if (typeof code !== "string") return undefined;
  const key = code.trim().toLowerCase();
  return isAiRefusalCode(key) ? key : undefined;
}

/**
 * Whether each refusal lifts on its own, as the backend classifies it. Only
 * two do: the policy could not be read (the backend fails closed), or the
 * org's provider is throttling or failing; both arrive as 503 with
 * `isRetryable: true`. Every other code is permanent until someone changes
 * the organization's configuration or the request's model.
 *
 * The harness model proxy (`./harness-proxy-refusal-reasons`) uses two of
 * these codes, `org_keys_required` and `ai_key_policy_unavailable`. It sends
 * `x-should-retry: false` for both: the proxy never re-sends a call, and the
 * coding agent behind it must not either. That is a rule for the proxy's own
 * replies. Everywhere else `ai_key_policy_unavailable` stays temporary, as
 * here. `ai-execution-refusal-harness-proxy.test.ts` pins this.
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

/** The refusals that lift on their own; see {@link RETRYABLE_BY_CODE}. */
export const AI_RETRYABLE_REFUSAL_CODES: ReadonlySet<string> = new Set(
  AI_REFUSAL_CODES.filter((code) => RETRYABLE_BY_CODE[code]),
);

/**
 * Refusals that are permanent until someone changes the organization's
 * configuration or the request's model: never retried automatically, never
 * paged, and never an account limit or a refund. The same set as the
 * backend's (every code it classifies `permanentUntilConfigurationChange`).
 */
export const AI_CONFIGURATION_REFUSAL_CODES: ReadonlySet<string> = new Set(
  AI_REFUSAL_CODES.filter((code) => !RETRYABLE_BY_CODE[code]),
);

/** See {@link AI_CONFIGURATION_REFUSAL_CODES}; tolerant of case and spacing. */
export function isAiConfigurationRefusalCode(
  code: string | null | undefined,
): boolean {
  if (typeof code !== "string") return false;
  return AI_CONFIGURATION_REFUSAL_CODES.has(code.trim().toLowerCase());
}

const ORG_KEY_POLICY_CODE_PATTERN = new RegExp(
  `\\b(${AI_EXECUTION_REFUSAL_CODES.join("|")})\\b`,
  "i",
);

/**
 * The first policy refusal code named anywhere in `text` (a raw error message,
 * a JSON envelope, a stored "Model selection refused — org_keys_required: …"
 * row), in canonical lowercase. Only the seven policy codes are searched for:
 * the reused codes are too generic to read out of free text.
 */
export function findOrgKeyPolicyRefusalCode(
  text: string | null | undefined,
): AiExecutionRefusalCode | undefined {
  if (typeof text !== "string" || !text) return undefined;
  const match = ORG_KEY_POLICY_CODE_PATTERN.exec(text);
  return match
    ? (match[1]!.toLowerCase() as AiExecutionRefusalCode)
    : undefined;
}

export type AiRefusalRemediation =
  | "choose_org_model"
  | "add_org_provider"
  | "configure_org_model_role"
  | "fix_org_credentials"
  | "unsupported"
  | "retry_later"
  | "contact_support";

/**
 * Whose choice the refused model was. The backend classifies each code the
 * same way on every surface, but the three model codes (`capability_missing`,
 * `capability_unknown`, `invalid_model`) have a different fix depending on
 * who chose the model:
 *
 * - `picked`: a person chose it (chat, eval targets, the judge). The fix is to
 *   choose another model. Model roles never apply to a picker.
 * - `role`: background work MCPJam runs on the organization's default model
 *   for a role (Fast, Smart, Embedding, Transcription). The fix is to set a
 *   different model for that role.
 *
 * Only the wording and the next step differ; the classification (permanent,
 * not retryable) is the same either way.
 */
export type AiRefusalSelection = "picked" | "role";

const REMEDIATION_BY_CODE: Readonly<
  Record<AiRefusalCode, AiRefusalRemediation>
> = {
  org_keys_required: "choose_org_model",
  org_model_unconfigured: "configure_org_model_role",
  org_runtime_unsupported: "unsupported",
  ai_scope_unresolved: "contact_support",
  ai_key_policy_unavailable: "retry_later",
  provider_auth_failed: "fix_org_credentials",
  provider_unavailable: "retry_later",
  credential_missing: "add_org_provider",
  capability_missing: "configure_org_model_role",
  capability_unknown: "configure_org_model_role",
  invalid_model: "configure_org_model_role",
};

/**
 * The remediation the backend pairs with `code`, exactly as its
 * classification table does. An unrecognized code gets `contact_support`: it
 * is not one a person can fix from settings. A surface showing the refusal
 * reads {@link aiRefusalRemediationFor} instead, which knows who chose the
 * model.
 */
export function aiRefusalRemediation(
  code: string | null | undefined,
): AiRefusalRemediation {
  const key = recognizedAiRefusalCode(code);
  return key ? REMEDIATION_BY_CODE[key] : "contact_support";
}

/** The model codes whose fix depends on {@link AiRefusalSelection}. */
const MODEL_REFUSAL_CODES = [
  "capability_missing",
  "capability_unknown",
  "invalid_model",
] as const satisfies readonly AiRefusalCode[];

export type ModelRefusalCode = (typeof MODEL_REFUSAL_CODES)[number];

const MODEL_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(
  MODEL_REFUSAL_CODES,
);

export function isModelRefusalCode(code: string): code is ModelRefusalCode {
  return MODEL_REFUSAL_CODE_SET.has(code);
}

/**
 * The next step for `code` on a surface where the model was `selection`. The
 * backend pairs the three model codes with `configure_org_model_role`, which
 * is right for role-backed work and wrong for a model a person picked: there
 * the fix is choosing another model.
 */
export function aiRefusalRemediationFor(
  code: string | null | undefined,
  selection: AiRefusalSelection = "picked",
): AiRefusalRemediation {
  const key = recognizedAiRefusalCode(code);
  if (selection === "picked" && key && isModelRefusalCode(key)) {
    return "choose_org_model";
  }
  return aiRefusalRemediation(code);
}

/** True for every {@link AiRefusalCode}, tolerant of case and spacing. */
export function isRecognizedAiRefusalCode(
  code: string | null | undefined,
): boolean {
  return recognizedAiRefusalCode(code) !== undefined;
}
