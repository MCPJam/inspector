import type { ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { shouldSkipGuestSession } from "@/lib/vanity-landing-hosts";
import LoadingScreen from "./LoadingScreen";
import { SessionRefreshBanner } from "./session-refresh-banner";
import { GuestSessionRefusedBanner } from "./guest-session-refused-banner";

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
  if (
    isLoading ||
    (!isAuthenticated && !shouldSkipGuestSession()) ||
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
