import { useEffect, useRef } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";

/**
 * Ensure a row exists in Convex `users` once per session, after Convex auth.
 * This runs only when both WorkOS and Convex are authenticated.
 */
export function useEnsureConvexUser() {
  const { user } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureUser = useMutation("users:ensureUser" as any);
  const hasEnsuredRef = useRef(false);

  useEffect(() => {
    if (hasEnsuredRef.current) return;
    if (isLoading) return;
    if (!isAuthenticated) return;
    if (!user) return;

    hasEnsuredRef.current = true;
    ensureUser()
      .then((id: string | null) => {
        // eslint-disable-next-line no-console
        console.log("[auth] ensured Convex user", { id, email: user.email });
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[auth] ensureUser failed", err);
        hasEnsuredRef.current = false; // allow retry on next auth change
      });
  }, [isAuthenticated, isLoading, user, ensureUser]);
}


