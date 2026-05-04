import { useEffect, useRef, useState } from "react";
import { useMutation, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import * as Sentry from "@sentry/react";
import {
  getExistingGuestBearerToken,
  revokeGuestSessionAndCookie,
} from "@/lib/guest-session";
import { useActorKey } from "@/hooks/use-actor-key";

/**
 * Ensure the current Convex-authenticated identity has a row in `users`.
 * Works for both signed-in WorkOS users and guest sessions — the backend
 * `users:ensureUser` mutation dispatches on the JWT issuer and creates the
 * appropriate row shape. Runs once per identity, idempotent.
 *
 * On the guest → WorkOS transition, forwards the guest bearer JWT as
 * `guestProofJwt` so the backend can verify guest ownership and promote
 * the guest's existing `users` row in place (preserving _id so projects
 * and history remain linked). After a successful promotion, revokes the
 * guest session so the HttpOnly cookie cannot resurrect the guest
 * identity if the user later signs out.
 */
export function useEnsureDbUser() {
  const { user } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const actorKey = useActorKey();
  const ensureUser = useMutation("users:ensureUser" as any);
  // Tracks the identity we last ensured for. Guest rows are keyed by the
  // cookie-backed guest id so in-tab guest rotation re-runs ensureUser.
  const lastEnsuredIdentityRef = useRef<string | null>(null);
  const [isEnsuringUser, setIsEnsuringUser] = useState(false);

  // Reset cache on Convex logout so we re-run for the next login in the same session.
  useEffect(() => {
    if (!isAuthenticated) {
      lastEnsuredIdentityRef.current = null;
      setIsEnsuringUser(false);
    }
  }, [isAuthenticated]);

  // WorkOS signout now falls back to Convex guest auth, so Convex can remain
  // authenticated while the Sentry user must be cleared.
  useEffect(() => {
    if (!user?.id) {
      Sentry.setUser(null);
    }
  }, [user?.id]);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (!isAuthenticated) {
      setIsEnsuringUser(false);
      return;
    }

    const identityKey = user?.id
      ? `workos:${user.id}`
      : actorKey
        ? `guest:${actorKey}`
        : null;
    if (!identityKey) {
      setIsEnsuringUser(false);
      return;
    }

    if (lastEnsuredIdentityRef.current === identityKey) {
      setIsEnsuringUser(false);
      return;
    }

    setIsEnsuringUser(true);
    let cancelled = false;

    const run = async () => {
      // Only the WorkOS branch can promote a guest. Skip the guest-token
      // lookup when the identity is itself a guest — there's nothing to
      // promote and the lookup would just round-trip needlessly.
      const isWorkOsAuth = !!user?.id;
      let guestProofJwt: string | null = null;
      if (isWorkOsAuth) {
        try {
          guestProofJwt = await getExistingGuestBearerToken();
        } catch {
          // Network/transient failure looking up an existing guest token is
          // not fatal — the user can still create a fresh org-owned account.
          // We intentionally don't fall through to creating a new guest.
          guestProofJwt = null;
        }
      }

      try {
        await ensureUser(
          guestProofJwt ? { guestProofJwt } : {},
        );
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error("[auth] ensureUser failed", err);
          lastEnsuredIdentityRef.current = null;
          setIsEnsuringUser(false);
        }
        return;
      }

      if (cancelled) return;

      lastEnsuredIdentityRef.current = identityKey;
      if (user?.id) {
        Sentry.setUser({ id: user.id });
      }

      // If we just authenticated as a WorkOS user and a guest cookie was
      // in play, retire it. Safe to call unconditionally — if no cookie
      // is set the server treats it as a no-op.
      if (isWorkOsAuth && guestProofJwt) {
        try {
          await revokeGuestSessionAndCookie();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[auth] guest session revoke failed", err);
        }
      }

      setIsEnsuringUser(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [actorKey, isAuthenticated, isLoading, user, ensureUser]);

  return { isEnsuringUser };
}
