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
 * The gateway's own sentences, addressed to the owner of MCPJam's gateway
 * account. Rows stored before the humanizer dropped `details` for this code
 * have them folded into the message; they are never the reader's to act on.
 */
const UPSTREAM_ALLOWLIST_SENTENCES = [
  /\s*Your team has restricted access to this provider\.?/gi,
  /\s*Update your Provider Allowlist settings to enable it\.?/gi,
];

function withoutUpstreamAllowlistSentences(message: string): string {
  return UPSTREAM_ALLOWLIST_SENTENCES.reduce(
    (text, pattern) => text.replace(pattern, ""),
    message,
  ).trim();
}

/**
 * The catalog one-liner's closing sentence. It is the part of this refusal a
 * reader most needs, so it follows the backend's sentence too.
 */
export const PROVIDER_NOT_ALLOWLISTED_NO_RETRY =
  "Retrying or changing your API key won't help.";

/**
 * The catalog entry for this refusal. `message` is the backend's sentence,
 * which names the provider; when present it replaces the catalog's generic
 * one-liner, followed by the no-retry sentence.
 */
export function describeProviderNotAllowlisted(
  message?: string | null,
): NormalizedError {
  const base = describeAsSlug(PROVIDER_NOT_ALLOWLISTED_SLUG);
  const providerSentence = withoutUpstreamAllowlistSentences(message ?? "");
  const oneLine = !providerSentence
    ? base.oneLine
    : providerSentence.includes(PROVIDER_NOT_ALLOWLISTED_NO_RETRY)
    ? providerSentence
    : `${providerSentence} ${PROVIDER_NOT_ALLOWLISTED_NO_RETRY}`;
  return { ...base, oneLine, rawMessage: oneLine };
}
