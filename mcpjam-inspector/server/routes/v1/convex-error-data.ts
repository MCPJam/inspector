type ConvexErrorData = {
  code?: unknown;
  message?: unknown;
  kind?: unknown;
  /** The stable sub-code a coded refusal carries alongside its prose. */
  reason?: unknown;
  /** The gated feature's key, on a `FEATURE_UNAVAILABLE` refusal. */
  feature?: unknown;
};

/**
 * Wrappers can preserve a message without copying the structured refusal data.
 * Walk the cause chain nearest first so they cannot erase a coded refusal.
 * Four errors bound the traversal even for self-referential causes.
 */
export function convexErrorData(error: unknown): ConvexErrorData | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as ConvexErrorData;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
