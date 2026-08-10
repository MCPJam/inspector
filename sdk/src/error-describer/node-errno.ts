/**
 * Shared Node errno extractor. Pure object/string inspection — no Node
 * imports, browser-safe. Originally lived inline at `sdk/src/retry.ts`
 * (extractNodeErrorCode); hoisted here so the error describer can share
 * the exact same surface as `isRetryableTransientError`.
 *
 * Walks `error.cause` because Node's `fetch` (undici) typically wraps
 * connection failures as `TypeError("fetch failed")` whose `.cause` is
 * the real `SystemError` carrying `code: "ECONNREFUSED"` (or similar).
 * Without the walk, every fetch-side errno would classify as the generic
 * "fetch failed" slug instead of the specific transport slug.
 *
 * Bounded depth to avoid pathological cyclic-cause structures.
 */
export function extractNodeErrno(
  error: unknown,
  depth = 0,
): string | undefined {
  if (!error || typeof error !== "object" || depth > 3) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  const ownCode = typeof code === "string" ? code : undefined;
  // A recognized errno wins immediately — nothing deeper can beat it.
  if (ownCode !== undefined && looksLikeNodeErrno(ownCode)) {
    return ownCode;
  }

  // An UNRECOGNIZED string code must NOT stop the walk. Wrappers stamp their
  // own domain codes on the outside of a chain (the MCP SDK's era-negotiation
  // failure carries `code: "ERA_NEGOTIATION_FAILED"`), and returning that here
  // shadowed the real `ECONNREFUSED` sitting one hop below — the caller then
  // classified a refused connection as a generic failure.
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error) {
    const fromCause = extractNodeErrno(cause, depth + 1);
    if (fromCause !== undefined) {
      return fromCause;
    }
  }
  // Nothing recognized anywhere in the chain: fall back to whatever string
  // code this level carried, preserving the previous contract for callers
  // that only test set membership.
  return ownCode;
}

/**
 * Recognition is by explicit membership, never by shape. An `E`-prefixed
 * screaming-snake pattern reads like a safe heuristic and is not: a wrapper
 * that stamps `code: "EWRAPPER"` on the outside of a chain would satisfy it,
 * end the walk, and hide the real `ECONNREFUSED` below — the exact failure
 * this walk exists to prevent, reintroduced through a looser door.
 *
 * An unlisted errno costs nothing: the walk continues, and `extractNodeErrno`
 * still returns the code as its last-resort fallback.
 */
function looksLikeNodeErrno(code: string): boolean {
  return RETRYABLE_NODE_ERROR_CODES.has(code) || code.startsWith("UND_ERR_");
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
