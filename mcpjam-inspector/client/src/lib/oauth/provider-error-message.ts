import { validateAuthorizationResponseIssuer } from "@mcpjam/sdk/browser";

/** Shown in place of a provider's own error text that can't be trusted. */
export const UNVERIFIED_PROVIDER_ERROR_MESSAGE =
  "Sign-in didn't finish. The sign-in provider returned an error. Try again.";

/**
 * The provider's `error_description` (or `error`), but only once the RFC 9207
 * issuer check passes. On a mismatch, or with no recorded issuer to check
 * against, the spec forbids acting on or displaying the server's `error*`
 * parameters, so a fixed message of our own stands in.
 */
export function providerErrorMessage(
  response: { error: string; errorDescription?: string; iss?: string },
  flow: { recordedIssuer?: string; issParameterSupported?: boolean },
): string {
  if (!flow.recordedIssuer) return UNVERIFIED_PROVIDER_ERROR_MESSAGE;
  const check = validateAuthorizationResponseIssuer({
    recordedIssuer: flow.recordedIssuer,
    returnedIss: response.iss,
    issParameterSupported: flow.issParameterSupported,
    enforcePresentIssMismatch: true,
  });
  if (!check.ok) return UNVERIFIED_PROVIDER_ERROR_MESSAGE;
  return response.errorDescription ?? response.error;
}
