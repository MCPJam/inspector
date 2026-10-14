/**
 * The error catalog's entries for the organization AI-key policy ("Use your
 * keys for all AI features"), kept apart so `catalog.ts` does not grow. Each
 * slug is named after the backend refusal code it describes; `describeError`
 * maps a code found on an error or in its message to the slug
 * (`org-policy.ts`).
 */
import type { ErrorCatalogEntry, ErrorOrigin } from "./catalog.js";

/** Who has to act for each policy refusal (see `ErrorOrigin`). */
export const ORG_POLICY_ERROR_ORIGINS: Record<string, ErrorOrigin> = {
  // Each is a backend refusal that is permanent until someone changes the
  // organization's configuration: the org requires its own keys and this
  // request would use another source, the org's default model is not set, the
  // feature has no org-credential adapter, the data-owning org could not be
  // resolved, or the org's own provider rejected its key. None pages.
  "org/keys_required": "user_config",
  "org/model_unconfigured": "user_config",
  "org/runtime_unsupported": "user_config",
  "org/scope_unresolved": "user_config",
  "org/provider_auth_failed": "user_config",
  // `credential_missing` on the org route: the saved org connection is gone,
  // disabled, or has no key. Only an admin's configuration change fixes it.
  "org/credential_missing": "user_config",
  // The org's provider throttled or failed. The refusal does not settle
  // whose fault that was (the org's account limits, the provider's outage),
  // so it never pages and never blames the key.
  "org/provider_unavailable": "ambiguous",
  // The backend could not read the organization's AI-key policy and failed
  // closed. No user input changes that; the policy store is ours.
  "org/key_policy_unavailable": "mcpjam",
};

/** `catalog.ts`'s own entry builder, passed in so the two modules share it. */
type CatalogEntryBuilder = (
  slug: string,
  title: string,
  oneLine: string,
  likelyCauses: string[],
  nextSteps: string[],
  anchor: string,
  severity?: ErrorCatalogEntry["severity"],
) => ErrorCatalogEntry;

/** The policy's catalog entries, built with `catalog.ts`'s `entry()`. */
export function orgPolicyCatalogEntries(
  entry: CatalogEntryBuilder,
): Record<string, ErrorCatalogEntry> {
  return {
    "org/keys_required": entry(
      "org/keys_required",
      "Organization provider required",
      "This organization requires its own provider keys for AI features, so MCPJam-provided models and personal keys are disabled. Choose a model from an organization provider.",
      [
        "The selected model is an MCPJam-provided (hosted) model, a personal key, or a local model, and the organization requires its own provider keys.",
      ],
      [
        "Choose a model from an organization provider.",
        "Organization admins can add a provider under Organization → AI providers.",
      ],
      "organization-provider-required",
      "warning",
    ),
    "org/model_unconfigured": entry(
      "org/model_unconfigured",
      "Organization model not configured",
      "This feature runs on the organization's default AI model, and none is set.",
      [
        "The organization requires its own provider keys, and work nobody picks a model for (insights, findings, generation, simulated users) runs on its default AI model.",
      ],
      [
        "Organization admins can choose one under Organization → AI providers → Default AI model.",
        "Members: ask an organization admin to configure one.",
      ],
      "organization-model-not-configured",
      "warning",
    ),
    "org/runtime_unsupported": entry(
      "org/runtime_unsupported",
      "Unavailable with organization keys",
      "This feature can't run on the organization's providers yet, so it is unavailable while the organization requires its own keys.",
      [
        "The feature, or the selected provider, has no organization-credential adapter yet (for example, it needs a local runtime or a shared gateway).",
      ],
      [
        "Choose a model from a directly connected cloud provider (OpenAI, Anthropic, Google, Azure, Bedrock, …).",
        "Organization admins can turn off the organization-keys requirement to use MCPJam-provided models for this feature.",
      ],
      "organization-runtime-unsupported",
      "warning",
    ),
    "org/scope_unresolved": entry(
      "org/scope_unresolved",
      "Organization could not be determined",
      "MCPJam could not tell which organization this AI request belongs to, so it was not run.",
      [
        "The project or resource is not in an organization, or the organization named by the request disagrees with the one that owns the data.",
      ],
      [
        "Open the request from the organization's project and try again.",
        "Contact support if this keeps happening.",
      ],
      "organization-scope-unresolved",
    ),
    "org/key_policy_unavailable": entry(
      "org/key_policy_unavailable",
      "Organization AI key policy unavailable",
      "MCPJam could not read the organization's AI settings, so it refused the request rather than guess.",
      [
        "A temporary failure reading the organization's AI-key policy.",
      ],
      ["Try again in a moment."],
      "organization-ai-key-policy-unavailable",
      "warning",
    ),
    "org/provider_auth_failed": entry(
      "org/provider_auth_failed",
      "Organization provider rejected the key",
      "The organization's model provider rejected its API key (401/403).",
      [
        "The organization's key for this provider is invalid, revoked, or for a different project or region.",
      ],
      [
        "Organization admins can update the key under Organization → AI providers.",
        "Members: ask an organization admin to update it.",
      ],
      "organization-provider-auth-failed",
    ),
    "org/credential_missing": entry(
      "org/credential_missing",
      "Organization provider missing",
      "The organization provider this model is saved to run on is no longer available, or has no key.",
      [
        "The organization connection was deleted, disabled or moved, or its API key was removed.",
      ],
      [
        "Choose a model from an organization provider that is still connected.",
        "Organization admins can add or reconnect the provider under Organization → AI providers.",
      ],
      "organization-provider-missing",
    ),
    "org/provider_unavailable": entry(
      "org/provider_unavailable",
      "Organization provider unavailable",
      "The organization's model provider is rate-limiting requests or temporarily failing.",
      [
        "The organization's provider account hit a rate limit or quota.",
        "The provider is having an outage.",
      ],
      [
        "Try again shortly.",
        "Check the provider's status page and the organization's limits on its dashboard.",
      ],
      "organization-provider-unavailable",
      "warning",
    ),
  };
}
