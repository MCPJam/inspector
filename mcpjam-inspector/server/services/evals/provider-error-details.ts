import { redactSecretShapes } from "@/shared/secret-shape-redaction";

/**
 * Enough of a provider error body to read the provider's explanation, and far
 * below Convex's per-value size limit.
 */
const PROVIDER_ERROR_DETAILS_MAX_CHARS = 8_000;

/**
 * A provider's error response body as an iteration may store and stream it.
 * Bodies can echo the request's key (masked or not), so credential shapes are
 * redacted, and a long body (an HTML error page) is cut on a code point.
 */
export function providerErrorDetails(responseBody: string): string {
  const redacted = redactSecretShapes(responseBody);
  const codePoints = Array.from(redacted);
  return codePoints.length > PROVIDER_ERROR_DETAILS_MAX_CHARS
    ? `${codePoints.slice(0, PROVIDER_ERROR_DETAILS_MAX_CHARS).join("")}…`
    : redacted;
}
