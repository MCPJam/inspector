/**
 * Client-side handling of the organization AI-key policy's refusals
 * ("Use your keys for all AI features").
 *
 * The vocabulary and the plain-language copy live in
 * `@/shared/ai-execution-refusal` (shared with the server and mirrored from
 * the backend). This module adds what only the browser needs: which codes the
 * chat banner treats as org-key refusals, how to pull one out of an error
 * envelope, and the short picker / status sentences.
 */
import {
  AI_EXECUTION_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  describeAiRefusal,
  findOrgKeyPolicyRefusalCode,
  type AiRefusalAudience,
  type AiRefusalDescription,
  type AiRefusalRemediation,
} from "@/shared/ai-execution-refusal";

export type { AiRefusalAudience, AiRefusalDescription, AiRefusalRemediation };

/**
 * The codes a chat or run surface renders as an org-key refusal: the seven
 * policy codes, plus `credential_missing`, which `/stream/org` answers with
 * when the org connection a selection names is gone or has no key.
 */
export const ORG_KEYS_REFUSAL_CODES: readonly string[] = [
  ...AI_EXECUTION_REFUSAL_CODES,
  "credential_missing",
];

const ORG_KEYS_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(
  ORG_KEYS_REFUSAL_CODES,
);

function normalizeCode(code: unknown): string | undefined {
  return typeof code === "string" ? code.trim().toLowerCase() : undefined;
}

/** True for one of {@link ORG_KEYS_REFUSAL_CODES} (case and spacing tolerant). */
export function isOrgKeysRefusalCode(code: unknown): boolean {
  const key = normalizeCode(code);
  return key !== undefined && ORG_KEYS_REFUSAL_CODE_SET.has(key);
}

/** The canonical (lowercase) spelling of an org-key refusal code, if it is one. */
export function orgKeysRefusalCodeOf(code: unknown): string | undefined {
  const key = normalizeCode(code);
  return key !== undefined && ORG_KEYS_REFUSAL_CODE_SET.has(key)
    ? key
    : undefined;
}

/**
 * Refusals that lift on their own (`ai_policy_unavailable`,
 * `provider_unavailable`). Every other org-key refusal is permanent until the
 * organization's configuration changes: no automatic retry, no "Analyze now".
 */
export function isRetryableOrgKeysRefusal(code: unknown): boolean {
  const key = normalizeCode(code);
  return key !== undefined && AI_RETRYABLE_REFUSAL_CODES.has(key);
}

/**
 * The org-key refusal code a raw error carries: a `{ code }` object, a JSON
 * envelope (`{ ok: false, code, error, … }` or a stream error chunk
 * `{ code, message, statusCode, isRetryable }`), or a worker's
 * `"<code>: <sentence>"` message. `undefined` for anything else.
 */
export function orgKeysRefusalCodeFromError(
  error: unknown,
): string | undefined {
  if (!error) return undefined;
  if (typeof error === "object" && !(error instanceof Error)) {
    const direct = orgKeysRefusalCodeOf((error as { code?: unknown }).code);
    if (direct) return direct;
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const fromData = orgKeysRefusalCodeOf((data as { code?: unknown }).code);
      if (fromData) return fromData;
    }
  }
  if (error instanceof Error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const fromData = orgKeysRefusalCodeOf((data as { code?: unknown }).code);
      if (fromData) return fromData;
    }
  }
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  if (!text) return undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { code?: unknown };
      const fromJson = orgKeysRefusalCodeOf(parsed?.code);
      if (fromJson) return fromJson;
    } catch {
      // Not JSON; fall through to the prefix form.
    }
  }
  const prefix = /^([a-z_]+)\s*:/i.exec(trimmed)?.[1];
  return orgKeysRefusalCodeOf(prefix);
}

/**
 * The org-key refusal code anywhere in a stored failure: its own code field,
 * a `"<code>: …"` prefix, or a policy code named inside the text (a run row
 * such as "Model selection refused — org_keys_required: …").
 */
export function orgKeysRefusalCodeInText(
  ...texts: Array<string | null | undefined>
): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const code =
      orgKeysRefusalCodeFromError(text) ?? findOrgKeyPolicyRefusalCode(text);
    if (code) return code;
  }
  return undefined;
}

/**
 * The one next step a refusal's remediation calls for, worded for whoever
 * reads it: `admin` may open Organization → AI providers, `member` asks an
 * admin.
 */
export function orgKeysRefusalNextStep(
  remediation: AiRefusalRemediation,
  audience: "admin" | "member" = "member",
): string {
  const admin = audience === "admin";
  switch (remediation) {
    case "choose_org_model":
      return "Choose a model from an organization provider.";
    case "configure_org_model_role":
      return admin
        ? "Set the organization's default models in Organization → AI providers."
        : "Ask an organization admin to set the organization's default models.";
    case "add_org_provider":
      return admin
        ? "Add or reconnect a provider in Organization → AI providers."
        : "Ask an organization admin to add or reconnect a provider.";
    case "fix_org_credentials":
      return admin
        ? "Update the provider's API key in Organization → AI providers."
        : "Ask an organization admin to update the provider's API key.";
    case "unsupported":
      return "This can't run while the organization requires its own keys.";
    case "retry_later":
      return "Try again in a moment.";
    case "contact_support":
    default:
      return "Contact support if this keeps happening.";
  }
}

/**
 * The refusal's copy for one reader. `admin` may open Organization → AI
 * providers; `member` is told to ask an admin; `visitor` (a share-link reader
 * outside the org) gets one neutral sentence with no admin detail.
 */
export function describeOrgKeysRefusal(
  code: string | null | undefined,
  audience: AiRefusalAudience = "member",
): AiRefusalDescription {
  return describeAiRefusal(code, audience);
}

/** The hint a member reads beside an org-key refusal they cannot fix. */
export const ASK_ORG_ADMIN = "Ask an organization admin";

/** The admin's action: Organization → AI providers. */
export const MANAGE_AI_PROVIDERS = "Manage AI providers";

/**
 * A picker row that the organization's policy no longer allows (a hosted or
 * personal model saved before the org required its own keys). Kept visible,
 * disabled, so the saved choice is never silently switched.
 */
export const ORG_KEYS_MODEL_REASON =
  "Choose a model from an organization provider.";

/**
 * Shown on every picker row while the organization's AI settings are still
 * loading: until the policy is known, no row may become a usable default.
 */
export const ORG_POLICY_LOADING_REASON =
  "Loading your organization's AI settings…";

/**
 * Shown on every picker row of a project no organization owns: no policy
 * applies, so no AI request may run.
 */
export const AI_SCOPE_UNRESOLVED_REASON =
  "This project isn't part of an organization, so AI models can't run here.";

/**
 * A row locked by the organization's AI key policy. A saved selection locked
 * this way stays selected (shown locked) rather than switching to another
 * model; a send surfaces the refusal.
 */
export function isOrgPolicyLockReason(
  reason: string | null | undefined,
): boolean {
  return (
    reason === ORG_KEYS_MODEL_REASON ||
    reason === ORG_POLICY_LOADING_REASON ||
    reason === AI_SCOPE_UNRESOLVED_REASON
  );
}

/** The visitor (share-link) sentence: no admin details, no configuration. */
export const VISITOR_ANALYSIS_UNAVAILABLE =
  "This organization's analysis is unavailable.";

/**
 * "Not analyzed: …" copy for an analysis an org-key refusal stopped, as a
 * status line reads it. The clause after the colon is the cause (no em dash:
 * product copy carries none); the fix is left to the surface (an admin
 * action or "Ask an organization admin").
 */
export function notAnalyzedReason(code: string | null | undefined): string {
  switch (normalizeCode(code)) {
    case "org_keys_required":
      return "Not analyzed: this organization requires its own provider keys for AI features.";
    case "org_model_unconfigured":
    case "org_model_unavailable":
      return "Not analyzed: this organization requires its own provider keys and has no model configured for analysis.";
    case "org_runtime_unsupported":
      return "Not analyzed: this analysis can't run on the organization's providers yet.";
    case "ai_scope_unresolved":
      return "Not analyzed: the organization that owns these sessions could not be determined.";
    case "ai_policy_unavailable":
      return "Not analyzed: the organization's AI settings could not be read. Try again.";
    case "provider_auth_failed":
      return "Not analyzed: the organization's provider rejected its API key.";
    case "provider_unavailable":
      return "Not analyzed: the organization's provider is temporarily unavailable. Try again shortly.";
    case "credential_missing":
      return "Not analyzed: the organization provider this analysis uses is no longer available.";
    default:
      return "Not analyzed: this organization's AI configuration refused the analysis.";
  }
}

/**
 * {@link notAnalyzedReason} for a status line under an analysis, or
 * `undefined` when `code` is neither an org-key refusal nor the automatic
 * findings skip `org_model_unavailable`.
 */
export function notAnalyzedLine(
  code: string | null | undefined,
): string | undefined {
  const key = normalizeCode(code);
  if (
    !key ||
    (!ORG_KEYS_REFUSAL_CODE_SET.has(key) && key !== "org_model_unavailable")
  )
    return undefined;
  return notAnalyzedReason(key);
}
