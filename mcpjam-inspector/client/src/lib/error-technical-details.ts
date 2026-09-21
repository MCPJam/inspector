/**
 * The diagnostic fields a bug report needs, attached CLIENT-SIDE.
 *
 * Deliberately not part of `describeError`. The server calls that describer and
 * puts the result straight into the JSON error body (`webError` → `normalized`),
 * so capturing a stack in there would ship server stacks to every browser —
 * the exact leak `WebRouteError` avoids by attaching its `cause`
 * non-enumerably. Everything here runs in the browser, on errors the browser
 * already holds, so there is nothing to leak.
 */
import {
  sanitizeTraceErrorMessage,
  type NormalizedError,
} from "@mcpjam/sdk/browser";

/**
 * Output cap for a captured stack. The SDK default suits one error message; a
 * stack legitimately needs more room.
 */
const MAX_REDACTED_STACK = 8_000;

/**
 * Redact a stack-shaped payload.
 *
 * Uses the SDK's single trace redactor rather than a local pattern list — a
 * private copy is how the sensitive-field set drifts.
 *
 * Redacted in ONE pass with a raised cap, never line by line: a multi-line
 * payload can put a JSON credential's key and its value on separate lines, and
 * splitting first hands the redactor two fragments that match neither, so the
 * value survives into copied output.
 */
export function redactStackLikeText(value: string | null | undefined): string {
  if (!value) return "";
  return sanitizeTraceErrorMessage(value, {
    maxLength: MAX_REDACTED_STACK,
    maxScanned: MAX_REDACTED_STACK * 2,
  });
}

function errorTypeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function requestIdOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const id = (error as { requestId?: unknown }).requestId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function stackOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const stack = error.stack;
  if (typeof stack !== "string" || stack.length === 0) return undefined;
  const redacted = redactStackLikeText(stack);
  return redacted.length > 0 ? redacted : undefined;
}

/**
 * Copy `errorType` / `stack` / `requestId` off the thrown value onto a
 * normalized block, without overwriting anything already there.
 *
 * Existing values win because a server-sent block is authoritative about the
 * failure the server saw; the local throw site only fills the gaps it left.
 */
export function withTechnicalDetails(
  normalized: NormalizedError,
  error: unknown,
): NormalizedError {
  const errorType = normalized.errorType ?? errorTypeOf(error);
  const requestId = normalized.requestId ?? requestIdOf(error);
  const stack = normalized.stack ?? stackOf(error);
  if (!errorType && !requestId && !stack) return normalized;
  return {
    ...normalized,
    ...(errorType ? { errorType } : {}),
    ...(requestId ? { requestId } : {}),
    ...(stack ? { stack } : {}),
  };
}
