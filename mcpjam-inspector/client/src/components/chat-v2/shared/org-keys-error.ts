/**
 * The chat error formatter's reading of an organization AI key policy refusal
 * ("Use your keys for all AI features"). The refusal keeps its code and
 * nothing else is layered on: no credit or limit reading and no connection
 * humanizer. `ErrorBox` renders it.
 */
import {
  isRetryableOrgKeysRefusal,
  orgKeysRefusalCodeFromError,
  orgKeysRefusalCodeOf,
} from "@/lib/org-keys-refusal";
import type { FormattedError } from "./chat-helpers";

/**
 * A parsed `{ ok: false, code, error, remediation?, statusCode?,
 * isRetryable? }` error body, when its code is an org-key refusal.
 * `undefined` otherwise, so the caller keeps reading it.
 */
export function formatOrgKeysRefusalEnvelope(
  parsed: Record<string, unknown>,
  message: string,
  details: string | undefined,
): FormattedError | undefined {
  const code = orgKeysRefusalCodeOf(parsed.code);
  if (!code) return undefined;
  const remediation =
    typeof parsed.remediation === "string" ? parsed.remediation : undefined;
  return {
    message,
    code,
    ...(details
      ? { details }
      : remediation
        ? { details: JSON.stringify({ code, remediation }) }
        : {}),
    ...(typeof parsed.statusCode === "number"
      ? { statusCode: parsed.statusCode }
      : {}),
    isRetryable:
      typeof parsed.isRetryable === "boolean"
        ? parsed.isRetryable
        : isRetryableOrgKeysRefusal(code),
    isMCPJamPlatformError: false,
  };
}

/**
 * A worker's `"<code>: <sentence>"` refusal (the backend's
 * `aiConfigurationRefusalCodeOf` reads the same shape), with the sentence as
 * the message. `undefined` when the text is not one.
 */
export function formatPrefixedOrgKeysRefusal(
  errorString: string,
): FormattedError | undefined {
  const code = orgKeysRefusalCodeFromError(errorString);
  if (!code) return undefined;
  const sentence = errorString
    .trim()
    .replace(/^[a-z_]+\s*:\s*/i, "")
    .trim();
  return {
    message: sentence || errorString,
    code,
    isRetryable: isRetryableOrgKeysRefusal(code),
    isMCPJamPlatformError: false,
  };
}
