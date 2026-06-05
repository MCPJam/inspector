/**
 * Shared Node errno extractor. Pure object/string inspection — no Node
 * imports, browser-safe. Originally lived inline at `sdk/src/retry.ts`
 * (extractNodeErrorCode); hoisted here so the error describer can share
 * the exact same surface as `isRetryableTransientError`.
 */
export function extractNodeErrno(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  return undefined;
}

/**
 * Retryable Node errno set — exposed so callers (including
 * `isRetryableTransientError`) can share one source of truth without
 * duplicating the literal list. Kept in this module because the catalog
 * also reads it.
 */
export const RETRYABLE_NODE_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
