/**
 * The inspector's gate on OAuth trace redaction.
 *
 * The redaction POLICY — which field names are secret, what a redacted value
 * looks like, how a free-form error string is scrubbed — lives in the SDK
 * (`oauth/state-machines/trace-redaction.ts`) and is re-exported here. It used
 * to be duplicated in `mcp-oauth.ts`, and the two copies had already drifted:
 * `state` was sensitive on the client side and not on the SDK side, so the same
 * value was redacted or published depending on which code path rendered it.
 *
 * What this module adds is the GATE. `SANITIZE_OAUTH_TRACES` is derived from
 * `HOSTED_MODE`: local traces stay raw, because showing the user exactly what
 * their own server said is the point of the inspector; hosted traces are
 * persisted, copied, and shipped, so they get redacted.
 *
 * Nothing here may be applied to data the OAuth flow CONSUMES. See the comment
 * on `parseOAuthResponseBody` in `mcp-oauth.ts`: running a live token response
 * through a redactor produces a non-empty string that passes every truthiness
 * check and then fails upstream as `Bearer abcd...[redacted]...yz`.
 */

import {
  sanitizeOAuthHeaders,
  sanitizeOAuthTraceValue,
  sanitizeOAuthUrl,
  sanitizeTraceErrorMessage,
} from "@mcpjam/sdk/browser";

import { SANITIZE_OAUTH_TRACES } from "@/lib/config";

export {
  OAUTH_TRACE_SENSITIVE_FIELD_NAMES,
  describeOAuthStateMatch,
  parseOAuthRequestFields,
  redactSensitiveTraceValue,
  sanitizeOAuthHeaders,
  sanitizeOAuthTraceValue,
  sanitizeOAuthUrl,
  sanitizeTraceErrorMessage,
} from "@mcpjam/sdk/browser";
export type { OAuthRequestFields } from "@mcpjam/sdk/browser";

/**
 * Re-exported under its historical name for the OAuth debugger's Sentry
 * reporting, which has always called it `sanitizeStepError`.
 */
export { sanitizeTraceErrorMessage as sanitizeStepError } from "@mcpjam/sdk/browser";

/** Gated: redact a URL destined for trace display. */
export function traceOAuthUrl(url: string): string {
  return SANITIZE_OAUTH_TRACES ? sanitizeOAuthUrl(url) : url;
}

/** Gated: redact request/response headers destined for trace display. */
export function traceOAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return SANITIZE_OAUTH_TRACES
    ? sanitizeOAuthHeaders(headers)
    : { ...headers };
}

/** Gated: redact a request/response body destined for trace display. */
export function traceOAuthValue(value: unknown): unknown {
  return SANITIZE_OAUTH_TRACES ? sanitizeOAuthTraceValue(value) : value;
}

/**
 * Gated: redact a free-form error message destined for trace display.
 *
 * This is the only redaction boundary the refresh flow has — it builds a
 * client-side trace and never projects an SDK snapshot, so
 * `projectOAuthTraceSnapshot({ sanitize })` never runs over it.
 */
export function traceOAuthErrorMessage(message: string): string {
  return SANITIZE_OAUTH_TRACES ? sanitizeTraceErrorMessage(message) : message;
}
