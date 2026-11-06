import { useSyncExternalStore, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { shouldSkipGuestSession } from "@/lib/vanity-landing-hosts";
import LoadingScreen from "./LoadingScreen";
import { SessionRefreshBanner } from "./session-refresh-banner";
import { GuestSessionRefusedBanner } from "./guest-session-refused-banner";
import {
  getGuestSessionRefusal,
  subscribeGuestSessionChanges,
} from "@/lib/guest-session";

/** Keep the auth providers mounted, but cancel every app subscriber during recovery. */
export function AuthRecoveryBoundary({
  children,
  ready = true,
}: {
  children: ReactNode;
  ready?: boolean;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const paused = useSessionRefreshStore((s) => s.queriesPaused);
  const confirmed = useSessionRefreshStore((s) => s.authConfirmed);
  // A refused guest never authenticates, so holding for one would spin
  // forever. Let the app render signed out; it offers sign-in from there.
  const guestRefused =
    useSyncExternalStore(
      subscribeGuestSessionChanges,
      getGuestSessionRefusal,
      () => null,
    ) !== null;
  if (
    isLoading ||
    (!isAuthenticated && !shouldSkipGuestSession() && !guestRefused) ||
    (paused && (!confirmed || !ready))
  ) {
    return (
      <>
        <LoadingScreen
          message={paused ? "Reconnecting your session…" : undefined}
        />
        <SessionRefreshBanner dismissible={false} />
        <GuestSessionRefusedBanner />
      </>
    );
  }
  return children;
}
