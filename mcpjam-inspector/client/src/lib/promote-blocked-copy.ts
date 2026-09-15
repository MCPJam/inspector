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
 * Our copy for a refusal the backend coded, or `null` when it did not code one.
 *
 * Split out from `getPromoteBlockedMessage` so BOTH halves of the promote
 * dialog can reach it: the load path wants a string it can always render,
 * while the submit path has to try billing copy before falling back. The same
 * refusal must read the same either way (BB-247).
 */
export function getPromotionBlockedCopy(error: unknown): string | null {
  const data = readConvexErrorPayload(error);
  if (!data || typeof data !== "object") return null;
  const code = "code" in data ? (data as { code: unknown }).code : null;
  if (typeof code !== "string") return null;
  // `hasOwn`, not truthiness: a bare object literal inherits `constructor`,
  // `toString` and friends, so `PROMOTION_BLOCKED_COPY["constructor"]` is a
  // truthy *function* under a signature that promises a string. Unreachable
  // while codes come from the backend's `as const`, but free to close.
  if (!Object.hasOwn(PROMOTION_BLOCKED_COPY, code)) return null;
  return PROMOTION_BLOCKED_COPY[code];
}

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
  fallback: string,
): string {
  const known = getPromotionBlockedCopy(error);
  if (known) return known;

  const data = readConvexErrorPayload(error);
  if (typeof data === "string") {
    return data.trim() ? data.slice(0, 400) : fallback;
  }
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.slice(0, 400);
    }
  }
  return fallback;
}

function readConvexErrorPayload(error: unknown): unknown {
  return error && typeof error === "object" && "data" in error
    ? (error as { data: unknown }).data
    : null;
}
