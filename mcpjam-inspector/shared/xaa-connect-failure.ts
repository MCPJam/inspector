/**
 * Classified connect-time Cross-App Access (XAA) failures.
 *
 * Shared because both ends of the failure need the same vocabulary: the server
 * classifies (`server/services/xaa-connect-error.ts`, which also owns the
 * sentences) and the client picks a TONE from the classification instead of
 * re-reading the sentence it is about to render.
 *
 * These strings are PERSISTED as `journeyRunAttempts.errorCode` by the swarm
 * runner, so renaming one silently changes how already-stored rows render.
 */
export const XaaConnectFailureReason = {
  /**
   * The caller's session no longer proves an identity to assert, so no ID-JAG
   * could be minted. RE-RUNNABLE: signing in again is the entire fix — nothing
   * is stored on the server row, so this reason must never outlive the session
   * that produced it, and must never be dressed up as a catastrophe.
   */
  REAUTH_REQUIRED: "xaa_reauth_required",
  /** No authorization server could be discovered for the resource. */
  AUTHORIZATION_SERVER_UNKNOWN: "xaa_authorization_server_unknown",
  /** The server's registration mode can't run here (DCR/CIMD unavailable). */
  NOT_SUPPORTED_HERE: "xaa_not_supported_here",
  /** The authorization server refused the token exchange. */
  AUTHORIZATION_REJECTED: "xaa_authorization_rejected",
  /** The stored server config is incomplete or contradictory. */
  CONFIGURATION_INVALID: "xaa_configuration_invalid",
  /** Anything we could not classify — still framed, never raw. */
  HANDSHAKE_FAILED: "xaa_handshake_failed",
} as const;

export type XaaConnectFailureReason =
  (typeof XaaConnectFailureReason)[keyof typeof XaaConnectFailureReason];

const XAA_CONNECT_FAILURE_REASONS = new Set<string>(
  Object.values(XaaConnectFailureReason)
);

export function isXaaConnectFailureReason(
  reason: string | null | undefined
): reason is XaaConnectFailureReason {
  return typeof reason === "string" && XAA_CONNECT_FAILURE_REASONS.has(reason);
}

/**
 * The XAA reason a thrown connect failure classified itself with
 * (`details.reason`, as `toXaaConnectFailure` writes it), or `undefined` for
 * any other error. Read structurally: the error can cross a route boundary, or
 * ride as the `cause` of a wrapper such as a failed swarm setup turn.
 */
export function xaaConnectFailureReasonOf(
  error: unknown
): XaaConnectFailureReason | undefined {
  const details = (error as { details?: unknown } | null | undefined)?.details;
  if (!details || typeof details !== "object") return undefined;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" && isXaaConnectFailureReason(reason)
    ? reason
    : undefined;
}

/**
 * True for the failures whose fix is "run the handshake again", not "something
 * is broken". The single input a surface needs to choose a calm treatment over
 * a red one: an authorization handshake that needs re-running is not an
 * incident, and red is reserved for what the user must actually go and fix.
 */
export function isRerunnableXaaFailure(
  reason: string | null | undefined
): boolean {
  return reason === XaaConnectFailureReason.REAUTH_REQUIRED;
}

/**
 * The authorization server's HTTP status a thrown connect failure carries
 * (`details.authorizationServerStatus`, as `toXaaConnectFailure` writes it), or
 * `undefined` when it never answered or the error is not one.
 */
export function xaaAuthorizationServerStatusOf(
  error: unknown
): number | undefined {
  const details = (error as { details?: unknown } | null | undefined)?.details;
  if (!details || typeof details !== "object") return undefined;
  const status = (details as { authorizationServerStatus?: unknown })
    .authorizationServerStatus;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

/**
 * True for a sign-in failure that will fail the same way if tried again right
 * away, so a run should stop signing in to that server rather than repeat it:
 * a configuration the server cannot use, or an authorization server that
 * answered MCPJam with a 4xx (a refusal, or 429 for asking too often). An
 * unclassified handshake failure, a timeout, an unreachable authorization
 * server or a 5xx may clear on the next try, as may 408 (request timeout) and
 * 425 (too early); an expired sign-in is re-run.
 *
 * `authorizationServerStatus` is the structured status, never one read back
 * out of the failure's sentence.
 */
export function isStandingXaaFailure(
  reason: string | null | undefined,
  authorizationServerStatus?: number
): boolean {
  switch (reason) {
    case XaaConnectFailureReason.CONFIGURATION_INVALID:
    case XaaConnectFailureReason.NOT_SUPPORTED_HERE:
    case XaaConnectFailureReason.AUTHORIZATION_SERVER_UNKNOWN:
      return true;
    case XaaConnectFailureReason.AUTHORIZATION_REJECTED:
      return (
        authorizationServerStatus !== undefined &&
        authorizationServerStatus >= 400 &&
        authorizationServerStatus < 500 &&
        authorizationServerStatus !== 408 &&
        authorizationServerStatus !== 425
      );
    default:
      return false;
  }
}
