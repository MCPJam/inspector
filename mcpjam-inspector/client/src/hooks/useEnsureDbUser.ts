import { useEffect, useRef, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import * as Sentry from "@sentry/react";

/**
 * Ensure the current Convex-authenticated identity has a row in `users`.
 * Works for both signed-in WorkOS users and guest sessions — the backend
 * `users:ensureUser` mutation dispatches on the JWT issuer and creates the
 * appropriate row shape. Runs once per identity, idempotent.
 */
export function useEnsureDbUser() {
  const { user } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureUser = useMutation("users:ensureUser" as any);
  // Tracks the identity (WorkOS id, or "__guest__" for guest sessions) we
  // last ensured for. We don't have the guest's external id on the client,
  // so a single sentinel is enough — guest identity rotation triggers a
  // fresh app load anyway.
  const lastEnsuredIdentityRef = useRef<string | null>(null);
  const [isEnsuringUser, setIsEnsuringUser] = useState(false);

  // Reset cache on logout so we re-run for the next login in the same session
  useEffect(() => {
    if (!isAuthenticated) {
      lastEnsuredIdentityRef.current = null;
      setIsEnsuringUser(false);
      Sentry.setUser(null); // Clear Sentry user on logout
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (!isAuthenticated) {
      setIsEnsuringUser(false);
      return;
    }

    const identityKey = user?.id ?? "__guest__";
    if (lastEnsuredIdentityRef.current === identityKey) {
      setIsEnsuringUser(false);
      return;
    }

    setIsEnsuringUser(true);
    ensureUser()
      .then(() => {
        lastEnsuredIdentityRef.current = identityKey;
        if (user?.id) {
          Sentry.setUser({ id: user.id });
        }
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error("[auth] ensureUser failed", err);
        // allow retry next effect pass
        lastEnsuredIdentityRef.current = null;
      })
      .finally(() => {
        setIsEnsuringUser(false);
      });
  }, [isAuthenticated, isLoading, user, ensureUser]);

  return { isEnsuringUser };
}
