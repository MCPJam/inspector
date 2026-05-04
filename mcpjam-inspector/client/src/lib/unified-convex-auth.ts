import { useEffect, useMemo, useState } from "react";
import { useAuth as useWorkOSAuth } from "@workos-inc/authkit-react";
import {
  forceRefreshGuestSession,
  getCachedGuestSession,
  getOrCreateGuestSession,
} from "@/lib/guest-session";

/**
 * Stable hook fed to `<ConvexProviderWithAuthKit useAuth={...}>`.
 *
 * Returns the same shape as `@workos-inc/authkit-react`'s `useAuth`, but
 * substitutes a guest token + placeholder user when there is no signed-in
 * WorkOS user. This makes Convex authenticate guests through the same
 * provider chain as authed users — no separate `<GuestConvexAuthBridge>`,
 * no `client.setAuth` race, no guest-specific code paths in feature
 * surfaces.
 *
 * The Convex/workos adapter (`@convex-dev/workos`) only inspects `!!user`
 * to decide `isAuthenticated` and calls `getAccessToken()` to fetch the
 * bearer. `GUEST_USER_PLACEHOLDER` exists solely to satisfy that check
 * for guests; nothing reads its fields.
 */

const GUEST_USER_PLACEHOLDER = {
  __guest: true as const,
  id: "__guest__",
};

export function useUnifiedConvexAuth() {
  const workos = useWorkOSAuth();
  const [guestToken, setGuestToken] = useState<string | null>(
    () => getCachedGuestSession()?.token ?? null,
  );
  const [guestLoading, setGuestLoading] = useState(true);

  // Fetch a guest token whenever there is no signed-in WorkOS user. Reset
  // when a user does sign in so subsequent renders favor the WorkOS path.
  useEffect(() => {
    if (workos.isLoading) {
      return;
    }
    if (workos.user) {
      setGuestToken(null);
      setGuestLoading(false);
      return;
    }

    let cancelled = false;
    setGuestLoading(true);
    getOrCreateGuestSession()
      .then((session) => {
        if (cancelled) return;
        setGuestToken(session?.token ?? null);
        setGuestLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setGuestLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workos.isLoading, workos.user]);

  return useMemo(() => {
    if (workos.user) {
      return {
        isLoading: workos.isLoading,
        user: workos.user,
        getAccessToken: workos.getAccessToken,
      };
    }

    return {
      isLoading: workos.isLoading || guestLoading,
      user: guestToken ? GUEST_USER_PLACEHOLDER : null,
      getAccessToken: async (
        opts?: { forceRefreshToken?: boolean },
      ): Promise<string | null> => {
        if (opts?.forceRefreshToken) {
          const refreshed = await forceRefreshGuestSession();
          setGuestToken(refreshed);
          return refreshed;
        }
        // Prefer the latest in-memory cache so a fresh token is used even
        // if React hasn't yet re-rendered with the new state.
        const cached = getCachedGuestSession()?.token ?? guestToken;
        return cached ?? null;
      },
    };
  }, [
    workos.isLoading,
    workos.user,
    workos.getAccessToken,
    guestToken,
    guestLoading,
  ]);
}
