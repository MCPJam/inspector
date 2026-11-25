import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  getCachedGuestId,
  getCachedGuestSession,
  getOrCreateGuestSession,
  hasCachedGuestSession,
  subscribeGuestSessionChanges,
} from "@/lib/guest-session";
import { shouldSkipGuestSession } from "@/lib/vanity-landing-hosts";

/**
 * Returns a stable key for the active actor (signed-in user or guest), or null
 * while the actor is still resolving.
 *
 * - For signed-in users: WorkOS user id.
 * - For guests: the cookie-backed `guestId` from the guest session.
 *
 * The key is used to scope per-actor localStorage so a previous actor's
 * selections (active project, etc.) don't bleed into the next session.
 */
export function useActorKey(): string | null {
  const { user, isLoading } = useAuth();
  const [guestId, setGuestId] = useState<string | null>(
    () => getCachedGuestSession()?.guestId ?? null
  );
  const previousUserIdRef = useRef<string | null>(user?.id ?? null);

  useEffect(() => {
    return subscribeGuestSessionChanges(() => {
      // An empty cache keeps the current guest. clearGuestSession() leaves the
      // cookie, so it resolves the same guest, and Convex keeps the token it
      // already holds; resetting here would leave Convex authenticated with
      // no actor whenever the re-lookup below fails.
      // revokeGuestSessionAndCookie() also empties the cache but expires the
      // cookie. Its callers run while signed in, so user.id wins, and the
      // sign-out effect after this one drops the guest.
      // getCachedGuestId() skips the expiry buffer, so a rotation to another
      // guest is followed even when the browser clock runs ahead.
      // A session cached without a guestId replaced the old guest's token,
      // and nothing ties it to that guest, so the old guest is dropped instead
      // of staying the key for its actor-scoped storage.
      const nextGuestId = getCachedGuestId();
      if (nextGuestId || hasCachedGuestSession()) setGuestId(nextGuestId);
    });
  }, []);

  useEffect(() => {
    if (isLoading) return;
    const previousUserId = previousUserIdRef.current;
    const nextUserId = user?.id ?? null;
    if (previousUserId && !nextUserId) {
      setGuestId(null);
    }
    previousUserIdRef.current = nextUserId;
  }, [isLoading, user?.id]);

  useEffect(() => {
    if (isLoading || user || guestId || shouldSkipGuestSession()) return;
    let cancelled = false;
    void getOrCreateGuestSession().then((session) => {
      if (cancelled) return;
      setGuestId(session?.guestId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [guestId, isLoading, user]);

  if (user?.id) return user.id;
  if (isLoading) return null;
  return guestId;
}
