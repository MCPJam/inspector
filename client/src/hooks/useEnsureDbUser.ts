import { useEffect, useRef } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";

/**
 * Ensure the authenticated WorkOS user has a row in Convex `users`.
 * - Runs only after Convex auth is established
 * - Idempotent and re-runs when the authenticated user changes
 */
export function useEnsureDbUser() {
  const { user } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureUser = useMutation("users:ensureUser" as any);
  const lastEnsuredUserIdRef = useRef<string | null>(null);

  // Reset cache on logout so we re-run for the next login in the same session
  useEffect(() => {
    if (!isAuthenticated) {
      lastEnsuredUserIdRef.current = null;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated && user){
      console.log('useEnsureDbUser: not authenticated');
      throw new Error('Not authenticated');
    }
    if (!isAuthenticated) return;
    if (!user) return;

    // Only (re)ensure when the authenticated WorkOS user changes.
    if (lastEnsuredUserIdRef.current === user.id) return;

    ensureUser()
      .then((id: string | null) => {
        // eslint-disable-next-line no-console
        lastEnsuredUserIdRef.current = user.id;
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[auth] ensureUser failed", err);
        // allow retry next effect pass
        lastEnsuredUserIdRef.current = null;
      });
  }, [isAuthenticated, isLoading, user, ensureUser]);
}
