import { useSyncExternalStore, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { shouldSkipGuestSession } from "@/lib/vanity-landing-hosts";
import { useStartupStatus, useStartupStore } from "@/lib/startup-status";
import { StartupRecoveryCard, StartupScreen } from "./startup/StartupScreen";
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
  const escalated = useStartupStore((s) => s.escalated);
  const status = useStartupStatus();
  const refusal = useSyncExternalStore(
    subscribeGuestSessionChanges,
    getGuestSessionRefusal,
    () => null,
  );
  if (
    isLoading ||
    (!isAuthenticated && !shouldSkipGuestSession()) ||
    (paused && (!confirmed || !ready))
  ) {
    // The app stays unmounted without auth so no protected subscription runs.
    // A refused guest never authenticates, though, so a spinner would never
    // end: the recovery card says why and offers Sign in.
    const settledRefusal = !isLoading && !paused && refusal;
    if (settledRefusal) return <StartupRecoveryCard status={status} />;
    return (
      <>
        <StartupScreen
          message={paused ? "Reconnecting your session…" : undefined}
        />
        {/* Once escalated, the recovery card carries the same actions. */}
        {!escalated && (
          <>
            <SessionRefreshBanner dismissible={false} />
            <GuestSessionRefusedBanner />
          </>
        )}
      </>
    );
  }
  return children;
}
