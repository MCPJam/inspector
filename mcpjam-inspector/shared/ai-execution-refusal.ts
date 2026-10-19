/**
 * The organization AI-key policy's refusal vocabulary ("Use your keys for all
 * AI features"), shared by the server and the browser.
 *
 * When an organization requires its own provider keys, every AI request must
 * run on an approved organization provider: MCPJam-provided (hosted) models,
 * personal local keys and keys exported for local execution are all refused.
 * The backend refuses with one of the codes re-exported below; its HTTP
 * bodies are
 * `{ ok: false, code, error, isRetryable, remediation, organizationId? }`.
 *
 * The code list and which codes lift on their own come from the SDK
 * (`sdk/src/ai-refusal-codes.ts`), the one copy the inspector, the CLI and
 * the SDK read; this module re-exports them. The remediation table below is
 * mirrored from the backend's own vocabulary file. Do not reword, reorder or
 * extend it here; change it there first.
 *
 * The harness model proxy (`./harness-proxy-refusal-reasons`) sends
 * `x-should-retry: false` for `ai_key_policy_unavailable` on its own replies;
 * everywhere else that code stays temporary.
 * `ai-execution-refusal-harness-proxy.test.ts` pins this.
 */

import {
  AI_CONFIGURATION_REFUSAL_CODES,
  AI_EXECUTION_REFUSAL_CODES,
  isAiExecutionRefusalCode,
  recognizedAiRefusalCode,
  type AiExecutionRefusalCode,
  type AiRefusalCode,
} from "@mcpjam/sdk/browser";

export {
  AI_CONFIGURATION_REFUSAL_CODES,
  AI_EXECUTION_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  AI_REUSED_REFUSAL_CODES,
  isAiExecutionRefusalCode,
  recognizedAiRefusalCode,
  type AiExecutionRefusalCode,
  type AiRefusalCode,
} from "@mcpjam/sdk/browser";

/**
 * The seven policy codes (`AI_EXECUTION_REFUSAL_CODES`), read tolerantly: a
 * stored row or a log line can carry the code in another case or with stray
 * whitespace. True only for the codes the org-key policy introduced, never for
 * the reused ones (`credential_missing`, `invalid_model`, …), which predate
 * the policy.
 */
export function isOrgKeyPolicyRefusalCode(
  code: string | null | undefined,
): boolean {
  if (typeof code !== "string") return false;
  return isAiExecutionRefusalCode(code.trim().toLowerCase());
}

/**
 * See `AI_CONFIGURATION_REFUSAL_CODES`: permanent until someone changes the
 * organization's configuration or the request's model. Tolerant of case and
 * spacing.
 */
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
  const code = ORG_KEY_POLICY_CODE_PATTERN.exec(text)?.[1]?.toLowerCase();
  return isAiExecutionRefusalCode(code) ? code : undefined;
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
 *   choose another model. The organization's default model never applies to
 *   a picker.
 * - `background`: work nobody picks a model for, which MCPJam runs on the
 *   organization's default model. The fix is an admin choosing a different
 *   default model. The backend uses the same name.
 *
 * Only the wording and the next step differ; the classification (permanent,
 * not retryable) is the same either way.
 */
export type AiRefusalSelection = "picked" | "background";

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
 * backend pairs the three model codes with `configure_org_model_role` (the
 * wire spelling for "set the organization's default model"), which is right
 * for background work and wrong for a model a person picked: there the fix
 * is choosing another model.
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
