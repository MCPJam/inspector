/**
 * Error handling utilities for MCPClientManager
 */

/**
 * Checks if an error indicates that a method is not available/implemented by the server.
 * Used for graceful degradation when servers don't support certain MCP features.
 *
 * @param error - The error to check
 * @param method - The MCP method name (e.g., "tools/list", "resources/list")
 * @returns True if the error indicates the method is unavailable
 */
export function isMethodUnavailableError(
  error: unknown,
  method: string
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Build set of tokens from the method name
  const methodTokens = new Set<string>();
  methodTokens.add(method.toLowerCase());
  for (const part of method.split(/[/:._-]/)) {
    if (part) {
      methodTokens.add(part.toLowerCase());
    }
  }

  // Common error indicators for unavailable methods
  const indicators = [
    "method not found",
    "not implemented",
    "unsupported",
    "does not support",
    "unimplemented",
    "unknown method",
    "unknown mcp method",
  ];

  const indicatorMatch = indicators.some((indicator) =>
    message.includes(indicator)
  );

  if (!indicatorMatch) {
    return false;
  }

  // Check if error mentions the method (or just assume it does if indicator matched)
  if (Array.from(methodTokens).some((token) => message.includes(token))) {
    return true;
  }

  // If we got an indicator match, assume it's about this method
  return true;
}

/**
 * Errors this SDK raises deliberately as a final verdict — they must never be
 * retried, however their message reads.
 *
 * The elicitation-aware tool timeout raises a timeout-shaped `SdkError`
 * ("Request timed out ..."), and {@link isRetryableTransientError} classifies
 * any error whose message mentions "timeout"/"timed out" as a retryable
 * transient. Retrying a budget we just declared exhausted is exactly wrong,
 * so the watchdog marks its error here and the retry classifier checks first.
 *
 * A WeakSet, not a property on the error. A string-keyed marker was readable —
 * and forgeable — through the prototype chain: any error inheriting a truthy
 * `__mcpjamNonRetryable` (including via prototype pollution) would have
 * silently suppressed legitimate retries. Set membership can't be inherited,
 * and nothing gets stamped onto errors we don't own.
 */
const nonRetryableErrors = new WeakSet<object>();

/**
 * Marks an error as never-retryable and returns it.
 */
export function markNonRetryableError<T extends object>(error: T): T {
  nonRetryableErrors.add(error);
  return error;
}

/**
 * Whether an error was explicitly marked as never-retryable.
 */
export function isNonRetryableMarkedError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    ? nonRetryableErrors.has(error)
    : false;
}

/**
 * Formats an error for display in error messages.
 *
 * @param error - The error to format
 * @returns A string representation of the error
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
