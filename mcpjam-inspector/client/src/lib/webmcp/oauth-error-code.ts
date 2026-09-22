/**
 * OAuth error-code allowlist shared by transcript-facing surfaces (the XAA
 * debugger UI and the oauth-flow agent snapshot/tool results).
 *
 * Only an allowlisted RFC 6749/8693/8707 code is ever stored, rendered, or
 * shipped into a chat transcript — never a raw error string, which can embed
 * tokens, URLs, or provider-specific detail.
 */

export const OAUTH_ERROR_CODES = [
  "invalid_grant",
  "access_denied",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_target",
] as const;

export function extractOauthErrorCode(
  error: string | undefined,
  lastResponse: { body?: unknown } | null | undefined,
): string | undefined {
  // Prefer the structured token response (`{error}` or the proxy envelope's
  // `{body: {error}}`) over substring-matching the message.
  const body = lastResponse?.body as Record<string, unknown> | undefined;
  const candidates = [
    body?.error,
    (body?.body as Record<string, unknown> | undefined)?.error,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      (OAUTH_ERROR_CODES as readonly string[]).includes(candidate)
    ) {
      return candidate;
    }
  }
  if (typeof error === "string") {
    return OAUTH_ERROR_CODES.find((code) => error.includes(code));
  }
  return undefined;
}
