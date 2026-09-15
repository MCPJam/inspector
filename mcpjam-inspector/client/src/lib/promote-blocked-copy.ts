/**
 * Codes the backend stamps on the `ConvexError` it throws when a promotion is
 * refused for a reason the user can act on (`convex/lib/promotableChatSessions.ts`,
 * `PROMOTION_BLOCKED_CODES`). Mirrored rather than imported — the two repos
 * ship separately, so the contract here is the wire string.
 */
const PROMOTION_BLOCKED_COPY: Record<string, string> = {
  SWARM_ATTEMPT_NOT_SUCCEEDED:
    "This session's run did not finish, so its conversation may be incomplete. Only sessions from runs that finished can become test cases.",
  SWARM_ATTEMPT_UNATTRIBUTED:
    "This session is not linked to a swarm run, so there is no run outcome to check. It cannot be promoted to a test case.",
};

/**
 * Human copy for a refused promote.
 *
 * Chosen by CODE, never by the thrown message. A plain `Error` thrown inside a
 * Convex function reaches the browser wrapped in the raw
 * "[CONVEX A(...)] ... Uncaught Error ... at handler (../convex/...)" envelope,
 * and that envelope was rendering verbatim inside the dialog's alert, stack
 * frames and file paths included (BB-247).
 *
 * Unrecognised failures fall back to the payload a `ConvexError` carries — a
 * string, or its `message` field — because those are written deliberately for
 * a reader (the content-transfer refusal and the suite-scope mismatch both
 * arrive that way). `Error.message` itself is NEVER shown: anything that is
 * not a `ConvexError` is an unexpected fault, and its message is the server
 * envelope this function exists to keep out of the UI. Callers get `fallback`
 * instead.
 */
export function getPromoteBlockedMessage(
  error: unknown,
  fallback: string
): string {
  const data =
    error && typeof error === "object" && "data" in error
      ? (error as { data: unknown }).data
      : null;
  if (typeof data === "string") {
    return data.trim() ? data.slice(0, 400) : fallback;
  }
  if (data && typeof data === "object") {
    const code = "code" in data ? (data as { code: unknown }).code : null;
    if (typeof code === "string" && PROMOTION_BLOCKED_COPY[code]) {
      return PROMOTION_BLOCKED_COPY[code];
    }
    const message =
      "message" in data ? (data as { message: unknown }).message : null;
    if (typeof message === "string" && message.trim()) {
      return message.slice(0, 400);
    }
  }
  return fallback;
}
