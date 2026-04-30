import { useEffect, useRef, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import * as Sentry from "@sentry/react";

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
  const [isEnsuringUser, setIsEnsuringUser] = useState(false);

  // Reset cache on logout so we re-run for the next login in the same session
  useEffect(() => {
    if (!isAuthenticated) {
      lastEnsuredUserIdRef.current = null;
      setIsEnsuringUser(false);
      Sentry.setUser(null); // Clear Sentry user on logout
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    // WorkOS user hydration can briefly lead Convex auth. This is expected
    // during callback completion; wait for isAuthenticated instead of throwing.
    if (!isAuthenticated || !user) {
      setIsEnsuringUser(false);
      return;
    }

    // Only (re)ensure when the authenticated WorkOS user changes.
    if (lastEnsuredUserIdRef.current === user.id) {
      setIsEnsuringUser(false);
      return;
    }

    setIsEnsuringUser(true);
    ensureUser()
      .then((id: string | null) => {
        // eslint-disable-next-line no-console
        lastEnsuredUserIdRef.current = user.id;
        // Set Sentry user context for error tracking
        Sentry.setUser({ id: user.id });
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[auth] ensureUser failed", err);
        // allow retry next effect pass
        lastEnsuredUserIdRef.current = null;
      })
      .finally(() => {
        setIsEnsuringUser(false);
      });
  }, [isAuthenticated, isLoading, user, ensureUser]);

  return { isEnsuringUser };
}
