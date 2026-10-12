/**
 * Client-side handling of the organization AI-key policy's refusals
 * ("Use your keys for all AI features").
 *
 * The vocabulary lives in `@/shared/ai-execution-refusal` (shared with the
 * server and mirrored from the backend), the plain-language copy in
 * `@/shared/ai-refusal-copy`. This module adds what only the browser needs: which codes the
 * chat banner treats as org-key refusals, how to pull one out of an error
 * envelope, the short next-step sentences, and the "Not analyzed" lines an
 * analysis the policy stopped reads as.
 */
import {
  AI_EXECUTION_REFUSAL_CODES,
  AI_RETRYABLE_REFUSAL_CODES,
  findOrgKeyPolicyRefusalCode,
  type AiExecutionRefusalCode,
  type AiRefusalRemediation,
  type AiRefusalSelection,
} from "@/shared/ai-execution-refusal";
import {
  describeAiRefusal,
  type AiRefusalAudience,
  type AiRefusalDescription,
} from "@/shared/ai-refusal-copy";

export type {
  AiRefusalAudience,
  AiRefusalDescription,
  AiRefusalRemediation,
  AiRefusalSelection,
};

/**
 * The codes a chat or run surface renders as an org-key refusal: the seven
 * policy codes, plus `credential_missing`, which `/stream/org` answers with
 * when the org connection a selection names is gone or has no key.
 */
export type OrgKeysRefusalCode = AiExecutionRefusalCode | "credential_missing";

export const ORG_KEYS_REFUSAL_CODES: readonly OrgKeysRefusalCode[] = [
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
 * Refusals that lift on their own (`ai_key_policy_unavailable`,
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
  // Errors included: one can carry the code with a generic message.
  if (typeof error === "object") {
    const direct = orgKeysRefusalCodeOf((error as { code?: unknown }).code);
    if (direct) return direct;
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
      // Not JSON: safe to ignore, the prefix form below still reads the code.
      // The text itself is not logged; it can carry a provider's message.
      console.debug("[org-keys-refusal] Error text is not JSON");
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
 * The sentence to show for an org-key refusal carried by a raw error message
 * (a stream error's `{ ok: false, code, error }` envelope, or a
 * `"<code>: …"` line): the backend's own reason when the envelope carries
 * one, else the plain-language copy for `audience`. `undefined` when the
 * message is not an org-key refusal, so a caller falls through to its own
 * handling instead of printing the raw envelope.
 */
export function orgKeysRefusalSentence(
  message: string | null | undefined,
  audience: AiRefusalAudience = "member",
): string | undefined {
  const code = orgKeysRefusalCodeFromError(message);
  if (!code || !message) return undefined;
  const trimmed = message.trim();
  if (trimmed.startsWith("{")) {
    try {
      const reason = (JSON.parse(trimmed) as { error?: unknown })?.error;
      // A reason, not the code echoed back as the error field.
      if (typeof reason === "string" && /\s/.test(reason.trim())) {
        return reason.trim();
      }
    } catch {
      // Not JSON: safe to ignore, the plain-language copy below stands in.
      console.debug("[org-keys-refusal] Refusal message is not JSON");
    }
  }
  return describeAiRefusal(code, audience).body;
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
      return "Choose a model from a directly connected cloud provider, such as OpenAI, Anthropic or Google.";
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
 * `selection` is who chose the refused model: a person (`picked`, the
 * default), or nobody, for background work on the organization's default
 * model (`background`).
 */
export function describeOrgKeysRefusal(
  code: string | null | undefined,
  audience: AiRefusalAudience = "member",
  selection: AiRefusalSelection = "picked",
): AiRefusalDescription {
  return describeAiRefusal(code, audience, selection);
}

/** The hint a member reads beside an org-key refusal they cannot fix. */
export const ASK_ORG_ADMIN = "Ask an organization admin";

/** The admin's action: Organization → AI providers. */
export const MANAGE_AI_PROVIDERS = "Manage AI providers";

/**
 * A saved model the organization's AI key policy no longer allows (a hosted
 * or personal model saved before the organization required its own keys).
 * Pickers never list it: it shows only on the trigger, as a warning, so the
 * saved choice is never silently switched.
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
 * A row locked by the organization's AI key policy. A saved selection locked
 * this way stays selected (shown on the trigger) rather than switching to
 * another model, and the chat does not send until another model is chosen.
 */
export function isOrgPolicyLockReason(
  reason: string | null | undefined,
): boolean {
  return (
    reason === ORG_KEYS_MODEL_REASON || reason === ORG_POLICY_LOADING_REASON
  );
}

/**
 * The automatic findings skip the backend records (`status: "skipped"`) when
 * the organization requires its own provider keys and nothing it has can run
 * the analysis. Not a refusal code: one of the backend's
 * `EvalFindingsSkipReason` values.
 */
export const ORG_ANALYSIS_SKIP_REASON = "org_model_unavailable";

/** What a share-link visitor reads: no configuration details, no codes. */
export const VISITOR_ANALYSIS_UNAVAILABLE = describeAiRefusal(
  null,
  "visitor",
).body;

type NotAnalyzedCode = OrgKeysRefusalCode | typeof ORG_ANALYSIS_SKIP_REASON;

/** Who reads a "Not analyzed" line: an admin can fix it, a member asks one. */
export type NotAnalyzedAudience = "admin" | "member";

type AnalysisConfigurationCode =
  | "org_keys_required"
  | "org_model_unconfigured"
  | typeof ORG_ANALYSIS_SKIP_REASON;

/** Analysis configuration needs its default-model guidance, not a model pick. */
const ANALYSIS_CONFIGURATION_COPY: Readonly<
  Record<
    AnalysisConfigurationCode,
    string | Readonly<Record<NotAnalyzedAudience, string>>
  >
> = {
  org_keys_required: {
    admin:
      "Not analyzed because this organization requires its own provider keys for AI features. Check its providers in Organization → AI providers.",
    member:
      "Not analyzed because this organization requires its own provider keys for AI features. Ask an organization admin to check its AI providers.",
  },
  org_model_unconfigured: {
    admin:
      "Not analyzed because this organization requires its own provider keys and has no model configured for analysis. Choose the organization's default AI model in Organization → AI providers.",
    member:
      "Not analyzed because this organization requires its own provider keys and has no model configured for analysis. Ask an organization admin to choose the organization's default AI model.",
  },
  org_model_unavailable:
    "Not analyzed because this organization requires its own provider keys and has no compatible default AI model. An organization admin needs to choose one in Organization → AI providers.",
};

const NOT_ANALYZED_FALLBACK: Readonly<Record<NotAnalyzedAudience, string>> = {
  admin:
    "Not analyzed because this organization's AI settings don't allow this analysis. Check its providers in Organization → AI providers.",
  member:
    "Not analyzed because this organization's AI settings don't allow this analysis. Ask an organization admin to check its AI providers.",
};

function notAnalyzedText(
  code: NotAnalyzedCode,
  audience: NotAnalyzedAudience,
): string {
  if (
    code === "org_keys_required" ||
    code === "org_model_unconfigured" ||
    code === ORG_ANALYSIS_SKIP_REASON
  ) {
    const copy = ANALYSIS_CONFIGURATION_COPY[code];
    return typeof copy === "string" ? copy : copy[audience];
  }
  return `Not analyzed. ${describeAiRefusal(code, audience).body}`;
}

function isNotAnalyzedCode(key: string): key is NotAnalyzedCode {
  return key === ORG_ANALYSIS_SKIP_REASON || isOrgKeysRefusalCode(key);
}

/**
 * The analysis status's line for `code`, for `audience`; a generic
 * one otherwise. Surfaces that don't know the reader's role get the member
 * wording.
 */
export function notAnalyzedReason(
  code: string | null | undefined,
  audience: NotAnalyzedAudience = "member",
): string {
  const key = normalizeCode(code);
  return key && isNotAnalyzedCode(key)
    ? notAnalyzedText(key, audience)
    : NOT_ANALYZED_FALLBACK[audience];
}

/**
 * {@link notAnalyzedReason} for a status line under an analysis, or
 * `undefined` when `code` is neither an org-key refusal nor the automatic
 * findings skip {@link ORG_ANALYSIS_SKIP_REASON}.
 */
export function notAnalyzedLine(
  code: string | null | undefined,
  audience: NotAnalyzedAudience = "member",
): string | undefined {
  const key = normalizeCode(code);
  return key && isNotAnalyzedCode(key)
    ? notAnalyzedText(key, audience)
    : undefined;
}
