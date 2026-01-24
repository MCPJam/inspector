/**
 * Custom error classes for MCP SDK
 */

/**
 * Base error class for all MCP SDK errors
 */
export class MCPError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "MCPError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Authentication error - thrown for 401, token expired, invalid token, etc.
 */
export class MCPAuthError extends MCPError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    options?: { cause?: unknown }
  ) {
    super(message, "AUTH_ERROR", options);
    this.name = "MCPAuthError";
  }
}

/**
 * Type guard to check if an error is an MCPAuthError
 */
export function isMCPAuthError(error: unknown): error is MCPAuthError {
  return error instanceof MCPAuthError;
}

/**
 * Type guard for errors with a numeric code property (like StreamableHTTPError, SseError)
 */
function hasNumericCode(error: unknown): error is Error & { code: number } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  );
}

/**
 * Checks if an error is an authentication-related error.
 * Detects auth errors by:
 * 1. Error class name (UnauthorizedError from MCP SDK)
 * 2. HTTP status codes (401, 403) from transport errors
 * 3. Common auth-related patterns in error messages (case-insensitive)
 */
export function isAuthError(error: unknown): {
  isAuth: boolean;
  statusCode?: number;
} {
  if (!(error instanceof Error)) {
    return { isAuth: false };
  }

  // Check for MCP SDK's UnauthorizedError by class name
  // (We check by name to avoid importing from @modelcontextprotocol/sdk)
  if (error.name === "UnauthorizedError") {
    return { isAuth: true, statusCode: 401 };
  }

  // Check for our own MCPAuthError by name
  if (error.name === "MCPAuthError") {
    const statusCode =
      "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    return { isAuth: true, statusCode };
  }

  // Check for transport errors with HTTP status codes (StreamableHTTPError, SseError)
  if (hasNumericCode(error)) {
    const code = error.code;
    if (code === 401 || code === 403) {
      return { isAuth: true, statusCode: code };
    }
  }

  // Fall back to message pattern matching (case-insensitive)
  const message = error.message.toLowerCase();
  const authPatterns = [
    "unauthorized",
    "invalid_token",
    "invalid token",
    "token expired",
    "token has expired",
    "access denied",
    "authentication failed",
    "authentication required",
    "not authenticated",
    "forbidden",
  ];

  if (authPatterns.some((pattern) => message.includes(pattern))) {
    return { isAuth: true };
  }

  // Check for HTTP status codes in error messages (e.g., "HTTP 401" or "status: 401")
  const statusMatch = message.match(/\b(status[:\s]*)?401\b|\bhttp\s*401\b/i);
  if (statusMatch) {
    return { isAuth: true, statusCode: 401 };
  }

  const forbiddenMatch = message.match(
    /\b(status[:\s]*)?403\b|\bhttp\s*403\b/i
  );
  if (forbiddenMatch) {
    return { isAuth: true, statusCode: 403 };
  }

  return { isAuth: false };
}
