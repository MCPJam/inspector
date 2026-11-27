import {
  contextLengthCounts,
  describeAsSlug,
  type NormalizedError,
} from "@mcpjam/sdk/browser";

/**
 * Backend code for a provider refusing a chat too long for the model's
 * context window (convex `lib/contextLengthError.ts`). Sent by `/stream` and
 * `/stream/org` with status 400, `isRetryable: false` and the provider's body
 * as `details`. The direct engine answers the same refusal with the same code.
 */
export const CONTEXT_LENGTH_EXCEEDED_CODE = "context_length_exceeded";

export function isContextLengthExceededCode(
  code: string | null | undefined,
): boolean {
  return code === CONTEXT_LENGTH_EXCEEDED_CODE;
}

/**
 * The catalog entry for this refusal, with the counts in its one line when
 * the provider's body (`details`) states them.
 */
export function describeContextLengthExceeded(
  details: string | null | undefined,
): NormalizedError {
  const base = describeAsSlug("provider/context_length_exceeded");
  const counts = details ? contextLengthCounts(details) : null;
  if (!counts) return base;
  return {
    ...base,
    oneLine: `This chat has ${counts.used.toLocaleString("en-US")} tokens, and the model accepts up to ${counts.limit.toLocaleString("en-US")}.`,
  };
}
