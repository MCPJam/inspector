import { ERROR_MESSAGES, type UserErrorMessage } from "./error-messages";

const catalogMessages = new Set<string>(Object.values(ERROR_MESSAGES));

/** Backend codes are mapped explicitly; backend prose is never user guidance. */
const codeMessages: Readonly<Record<string, UserErrorMessage>> = {
  auth_error: ERROR_MESSAGES.modelProviderAuthenticationFailed,
  RATE_LIMITED: ERROR_MESSAGES.rateLimited,
  ENV_MODEL_REQUIRED: ERROR_MESSAGES.environmentModelRequired,
  ENV_NO_SERVERS: ERROR_MESSAGES.environmentNoServers,
  ENV_ARCHIVED: ERROR_MESSAGES.environmentArchived,
  ENV_HOST_MISSING: ERROR_MESSAGES.environmentHostMissing,
  ENV_ATTACHMENT_MISSING: ERROR_MESSAGES.environmentAttachmentMissing,
  SCENARIO_SIGN_IN_REQUIRED: ERROR_MESSAGES.signInRequired,
  SCENARIO_ACCESS_DENIED: ERROR_MESSAGES.accessDenied,
  UNAUTHORIZED: ERROR_MESSAGES.signInRequired,
  billing_organization_context_required: ERROR_MESSAGES.organizationRequired,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Accept only catalog copy. Unknown errors get a catalog fallback, including
 * ConvexError.data, JSON response bodies, Error.message and plain strings.
 * Classification/telemetry must receive the original error, not this output.
 * A caller-supplied fallback is checked too: server text cannot bypass the
 * policy by arriving in the second argument.
 */
export function getUserErrorMessage(
  error: unknown,
  fallback: string = ERROR_MESSAGES.unexpected,
): UserErrorMessage {
  const safeFallback = isUserErrorMessage(fallback)
    ? fallback
    : ERROR_MESSAGES.unexpected;
  try {
    const outer = record(error);
    const data = record(outer?.data);
    const details = record(outer?.details);
    const code = details?.code ?? data?.code ?? outer?.code ?? outer?.rawCode;
    if (typeof code === "string" && Object.hasOwn(codeMessages, code)) {
      return codeMessages[code];
    }
    // Only exact catalog strings can pass through. Never strip prefixes or
    // partially match backend text and then render the remainder.
    for (const candidate of [
      error,
      outer?.data,
      data?.message,
      outer?.message,
    ]) {
      if (isUserErrorMessage(candidate)) return candidate;
    }
  } catch {
    // Even an unusual thrown value with a throwing getter gets usable copy.
  }
  return safeFallback;
}

export function isUserErrorMessage(value: unknown): value is UserErrorMessage {
  return typeof value === "string" && catalogMessages.has(value);
}
