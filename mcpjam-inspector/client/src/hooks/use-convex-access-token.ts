import { useCallback } from "react";
import { useAuth } from "@workos-inc/authkit-react";

import { resolveConvexAccessToken } from "@/lib/auth/resolve-convex-access-token";

/**
 * Returns a stable getter that resolves the Convex bearer token for the
 * current actor — the WorkOS access token for signed-in users, or the guest
 * bearer for guests. Use this for any request that forwards a
 * `convexAuthToken` (eval runs, test generation) so guests authenticate the
 * same way the chat session does.
 *
 * See {@link resolveConvexAccessToken} for why the guest fallback keys on the
 * presence of a WorkOS user rather than `isDirectGuest`.
 */
export function useConvexAccessToken(): () => Promise<string | null> {
  const { user, getAccessToken } = useAuth();
  return useCallback(
    () =>
      resolveConvexAccessToken({
        getWorkosAccessToken: getAccessToken,
        hasWorkosUser: Boolean(user),
      }),
    [user, getAccessToken],
  );
}
