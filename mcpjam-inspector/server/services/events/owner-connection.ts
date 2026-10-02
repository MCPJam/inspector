/**
 * Connecting to a subscription's server AS ITS OWNER, with the hosted OAuth
 * connection the subscription was created under (C2 binding).
 *
 * The keeper and the executor both build managers through
 * `createAuthorizedManager`. Without a `connectionIds` entry that resolves
 * the owner's DEFAULT connection, so an owner switching their default from
 * account A to B would move the subscription onto B. With it, the backend
 * resolves exactly the pinned connection; when that connection is gone or
 * needs reconnecting there is no token, and authorize refuses (401) rather
 * than falling back to the default.
 */

import { WebRouteError } from "../../routes/web/errors.js";

/** `createAuthorizedManager`'s `connectionIds` for the pinned connection. */
export function pinnedConnectionIds(
  serverId: string,
  oauthConnectionId: string | null | undefined,
): { connectionIds: Record<string, string> } | undefined {
  return oauthConnectionId ? { connectionIds: { [serverId]: oauthConnectionId } } : undefined;
}

/**
 * Whether connecting as the owner failed for want of authorization: the
 * authorize step refused (the owner's pinned connection is gone or needs
 * reconnecting, or the owner lost access), not an outage.
 */
export function isOwnerAuthorizationRefusal(error: unknown): boolean {
  return error instanceof WebRouteError && (error.status === 401 || error.status === 403);
}

/**
 * The same refusal in the shape the events coordinator classifies as lost
 * authorization (`isAuthError`), so the step parks `paused_auth` instead of
 * retrying a connection that cannot work until the owner reconnects.
 */
export function asAuthorizationLost(error: unknown): unknown {
  if (!isOwnerAuthorizationRefusal(error)) return error;
  const lost = new Error((error as Error).message, { cause: error });
  lost.name = "UnauthorizedError";
  return lost;
}
