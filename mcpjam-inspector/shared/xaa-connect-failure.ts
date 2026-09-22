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
