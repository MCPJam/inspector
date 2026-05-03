import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  getCachedGuestSession,
  getOrCreateGuestSession,
} from "@/lib/guest-session";

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
    () => getCachedGuestSession()?.guestId ?? null,
  );

  useEffect(() => {
    if (isLoading || user) return;
    let cancelled = false;
    void getOrCreateGuestSession().then((session) => {
      if (cancelled) return;
      setGuestId(session?.guestId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [isLoading, user]);

  if (user?.id) return user.id;
  if (isLoading) return null;
  return guestId;
}
