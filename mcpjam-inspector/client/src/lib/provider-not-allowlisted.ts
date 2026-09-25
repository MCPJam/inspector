import { describeAsSlug, type NormalizedError } from "@mcpjam/sdk/browser";

/**
 * Backend code for a request the hosted AI gateway refused because the
 * model's provider is not enabled on MCPJam's gateway (its provider
 * allowlist). Sent by `/stream` with the upstream 401/403 status and
 * `isRetryable: false`.
 *
 * Not a credential failure: the user's API keys were never involved, and
 * retrying sends the same request into the same refusal. Surfaces render it
 * with the `provider/not_allowlisted` catalog entry, which offers another
 * model or the user's own provider key — never "check your API key".
 */
export const PROVIDER_NOT_ALLOWLISTED_CODE = "provider_not_allowlisted";

export const PROVIDER_NOT_ALLOWLISTED_SLUG = "provider/not_allowlisted";

export function isProviderNotAllowlistedCode(
  code: string | null | undefined,
): boolean {
  return code === PROVIDER_NOT_ALLOWLISTED_CODE;
}

/**
 * The catalog entry for this refusal. `message` is the backend's sentence,
 * which names the provider; it replaces the catalog's generic one-liner when
 * present.
 */
export function describeProviderNotAllowlisted(
  message?: string | null,
): NormalizedError {
  const base = describeAsSlug(PROVIDER_NOT_ALLOWLISTED_SLUG);
  const oneLine = message?.trim() || base.oneLine;
  return { ...base, oneLine, rawMessage: oneLine };
}
