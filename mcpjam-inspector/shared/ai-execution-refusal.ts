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
  "ai_policy_unavailable",
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
 * The two refusals that lift on their own: the policy could not be read (the
 * backend fails closed), or the org's provider is throttling or failing. Both
 * arrive as 503 with `isRetryable: true`.
 */
export const AI_RETRYABLE_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "ai_policy_unavailable",
  "provider_unavailable",
]);

/**
 * Refusals that are permanent until someone changes the organization's
 * configuration: never retried automatically, never paged, and never an
 * account limit or a refund. `credential_missing` is reused from the org
 * model resolver (the saved connection is gone or has no key).
 */
export const AI_CONFIGURATION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "org_keys_required",
  "org_model_unconfigured",
  "org_runtime_unsupported",
  "ai_scope_unresolved",
  "provider_auth_failed",
  "credential_missing",
]);

/** See {@link AI_CONFIGURATION_REFUSAL_CODES}; tolerant of case and spacing. */
export function isAiConfigurationRefusalCode(
  code: string | null | undefined,
): boolean {
  if (typeof code !== "string") return false;
  return AI_CONFIGURATION_REFUSAL_CODES.has(code.trim().toLowerCase());
}

/**
 * Every code a policy-aware surface recognizes: the seven policy codes plus
 * the reused model-resolution codes the backend answers with for an
 * ineligible selection.
 */
const RECOGNIZED_AI_REFUSAL_CODES: readonly string[] = [
  ...AI_EXECUTION_REFUSAL_CODES,
  "credential_missing",
  "capability_missing",
  "capability_unknown",
  "invalid_model",
];

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

export type AiRefusalAudience = "admin" | "member" | "visitor";

export type AiRefusalRemediation =
  | "choose_org_model"
  | "add_org_provider"
  | "configure_org_model_role"
  | "fix_org_credentials"
  | "unsupported"
  | "retry_later"
  | "contact_support";

export type AiRefusalDescription = {
  title: string;
  body: string;
  remediation: AiRefusalRemediation;
};

const REMEDIATION_BY_CODE: Readonly<Record<string, AiRefusalRemediation>> = {
  org_keys_required: "choose_org_model",
  org_model_unconfigured: "configure_org_model_role",
  org_runtime_unsupported: "unsupported",
  ai_scope_unresolved: "contact_support",
  ai_policy_unavailable: "retry_later",
  provider_auth_failed: "fix_org_credentials",
  provider_unavailable: "retry_later",
  credential_missing: "add_org_provider",
  capability_missing: "configure_org_model_role",
  capability_unknown: "configure_org_model_role",
  invalid_model: "configure_org_model_role",
};

/**
 * The remediation the backend pairs with `code`. An unrecognized code gets
 * `contact_support`: it is not one a person can fix from settings.
 */
export function aiRefusalRemediation(
  code: string | null | undefined,
): AiRefusalRemediation {
  const key = typeof code === "string" ? code.trim().toLowerCase() : "";
  return REMEDIATION_BY_CODE[key] ?? "contact_support";
}

type AudienceCopy = { title: string; admin: string; member: string };

/**
 * Plain-language copy per code. `admin` names the fix in Organization → AI
 * providers; `member` sends the reader to an admin. Visitors (share links)
 * never see either: they get one sentence with no admin detail.
 */
const COPY_BY_CODE: Readonly<Record<string, AudienceCopy>> = {
  org_keys_required: {
    title: "Organization provider required",
    admin:
      "This organization requires its own provider keys for AI features. MCPJam-provided models are disabled. Choose a model from an organization provider.",
    member:
      "This organization requires its own provider keys for AI features. Choose a model from an organization provider, or ask an organization admin to add one.",
  },
  org_model_unconfigured: {
    title: "Unavailable: no organization model set",
    admin:
      "This feature needs a default organization model and none is set. Choose one in Organization → AI providers.",
    member:
      "This feature needs a default organization model and none is set. Ask an organization admin to configure one.",
  },
  org_runtime_unsupported: {
    title: "Unavailable with organization keys",
    admin:
      "This feature can't run on the organization's providers yet, so it is unavailable while the organization requires its own keys.",
    member:
      "This feature can't run on the organization's providers yet, so it is unavailable while the organization requires its own keys.",
  },
  ai_scope_unresolved: {
    title: "Organization could not be determined",
    admin:
      "MCPJam could not tell which organization this AI request belongs to, so it was not run. Contact support if this keeps happening.",
    member:
      "MCPJam could not tell which organization this AI request belongs to, so it was not run. Ask an organization admin or contact support if this keeps happening.",
  },
  ai_policy_unavailable: {
    title: "AI temporarily unavailable",
    admin:
      "MCPJam could not read the organization's AI settings, so the request was not run. Try again in a moment.",
    member:
      "MCPJam could not read the organization's AI settings, so the request was not run. Try again in a moment.",
  },
  provider_auth_failed: {
    title: "Organization provider rejected the key",
    admin:
      "The organization's provider rejected its API key. Update the key in Organization → AI providers.",
    member:
      "The organization's provider rejected its API key. Ask an organization admin to update it.",
  },
  provider_unavailable: {
    title: "Organization provider unavailable",
    admin:
      "The organization's provider is rate-limiting or temporarily failing. Try again shortly, or check the provider's status and limits.",
    member:
      "The organization's provider is rate-limiting or temporarily failing. Try again shortly.",
  },
  credential_missing: {
    title: "Unavailable: add an organization provider",
    admin:
      "No usable organization provider is configured for this request. Add or reconnect one in Organization → AI providers.",
    member:
      "No usable organization provider is configured for this request. Ask an organization admin to add one.",
  },
  capability_missing: {
    title: "Model can't do this",
    admin:
      "The selected model does not support what this feature needs. Choose a different model from an organization provider.",
    member:
      "The selected model does not support what this feature needs. Choose a different model from an organization provider.",
  },
  capability_unknown: {
    title: "Model support unknown",
    admin:
      "MCPJam can't confirm the selected model supports this feature. Choose a different model from an organization provider.",
    member:
      "MCPJam can't confirm the selected model supports this feature. Choose a different model from an organization provider.",
  },
  invalid_model: {
    title: "Model unavailable",
    admin:
      "The selected model is not available. Choose a model from an organization provider.",
    member:
      "The selected model is not available. Choose a model from an organization provider.",
  },
};

const FALLBACK_COPY: AudienceCopy = {
  title: "AI unavailable",
  admin:
    "This AI request was refused. Contact support if this keeps happening.",
  member:
    "This AI request was refused. Ask an organization admin or contact support if this keeps happening.",
};

const VISITOR_TITLE = "Analysis unavailable";
const VISITOR_BODY = "This organization's analysis is unavailable.";

/**
 * Plain-language copy for a refusal, by who is reading it.
 *
 * - `admin` — can act: the body names Organization → AI providers.
 * - `member` — cannot: the body says to ask an organization admin.
 * - `visitor` — a share-link reader outside the org: one neutral sentence,
 *   no admin details and nothing about the org's configuration.
 *
 * Never throws; an unrecognized code reads as a generic refusal with
 * `contact_support`.
 */
export function describeAiRefusal(
  code: string | null | undefined,
  audience: AiRefusalAudience = "member",
): AiRefusalDescription {
  const remediation = aiRefusalRemediation(code);
  if (audience === "visitor") {
    return { title: VISITOR_TITLE, body: VISITOR_BODY, remediation };
  }
  const key = typeof code === "string" ? code.trim().toLowerCase() : "";
  const copy = COPY_BY_CODE[key] ?? FALLBACK_COPY;
  return {
    title: copy.title,
    body: audience === "admin" ? copy.admin : copy.member,
    remediation,
  };
}

/** Every code {@link describeAiRefusal} has dedicated copy for. */
export function isRecognizedAiRefusalCode(
  code: string | null | undefined,
): boolean {
  if (typeof code !== "string") return false;
  return RECOGNIZED_AI_REFUSAL_CODES.includes(code.trim().toLowerCase());
}
