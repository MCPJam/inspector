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
