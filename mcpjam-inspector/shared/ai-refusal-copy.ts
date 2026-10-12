/**
 * Plain-language copy for the organization AI-key policy's refusals, by who
 * is reading and who chose the refused model. The codes and their
 * classification live in `./ai-execution-refusal`.
 */
import {
  aiRefusalRemediationFor,
  isModelRefusalCode,
  recognizedAiRefusalCode,
  type AiRefusalCode,
  type AiRefusalRemediation,
  type AiRefusalSelection,
  type ModelRefusalCode,
} from "./ai-execution-refusal.js";

export type AiRefusalAudience = "admin" | "member" | "visitor";

export type AiRefusalDescription = {
  title: string;
  body: string;
  remediation: AiRefusalRemediation;
};

type AudienceCopy = { title: string; admin: string; member: string };

/**
 * Plain-language copy per code. `admin` names the fix in Organization → AI
 * providers; `member` sends the reader to an admin. Visitors (share links)
 * never see either: they get one sentence with no admin detail.
 */
const COPY_BY_CODE: Readonly<Record<AiRefusalCode, AudienceCopy>> = {
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
  ai_key_policy_unavailable: {
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

/**
 * The model codes' copy for background work: the model is the organization's
 * default model, so the fix is a different default model, not a different
 * pick.
 */
const BACKGROUND_COPY_BY_CODE: Readonly<
  Record<ModelRefusalCode, AudienceCopy>
> = {
  capability_missing: {
    title: "Model can't do this",
    admin:
      "The organization model set for this feature does not support what it needs. Choose a different default model in Organization → AI providers.",
    member:
      "The organization model set for this feature does not support what it needs. Ask an organization admin to choose a different one.",
  },
  capability_unknown: {
    title: "Model support unknown",
    admin:
      "MCPJam can't confirm the organization model set for this feature supports it. Choose a different default model in Organization → AI providers.",
    member:
      "MCPJam can't confirm the organization model set for this feature supports it. Ask an organization admin to choose a different one.",
  },
  invalid_model: {
    title: "Model unavailable",
    admin:
      "The organization model set for this feature is not available. Choose a different default model in Organization → AI providers.",
    member:
      "The organization model set for this feature is not available. Ask an organization admin to choose a different one.",
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
 * `selection` says who chose the refused model (see
 * {@link AiRefusalSelection}); it changes only the three model codes.
 *
 * Never throws; an unrecognized code reads as a generic refusal with
 * `contact_support`.
 */
export function describeAiRefusal(
  code: string | null | undefined,
  audience: AiRefusalAudience = "member",
  selection: AiRefusalSelection = "picked",
): AiRefusalDescription {
  const remediation = aiRefusalRemediationFor(code, selection);
  if (audience === "visitor") {
    return { title: VISITOR_TITLE, body: VISITOR_BODY, remediation };
  }
  const key = recognizedAiRefusalCode(code);
  const copy = !key
    ? FALLBACK_COPY
    : selection === "background" && isModelRefusalCode(key)
      ? BACKGROUND_COPY_BY_CODE[key]
      : COPY_BY_CODE[key];
  return {
    title: copy.title,
    body: audience === "admin" ? copy.admin : copy.member,
    remediation,
  };
}
