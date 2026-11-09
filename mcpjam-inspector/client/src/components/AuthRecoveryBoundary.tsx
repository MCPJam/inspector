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
import { guestSessionRefusalCopy } from "@/lib/guest-session-refusal-copy";

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
    // end: say why instead, under the banner's Sign in button.
    const settledRefusal = !isLoading && !paused && refusal;
    return (
      <>
        {settledRefusal ? (
          <SignedOutScreen
            message={guestSessionRefusalCopy(settledRefusal.reason).summary}
          />
        ) : (
          <LoadingScreen
            message={paused ? "Reconnecting your session…" : undefined}
          />
        )}
        <SessionRefreshBanner dismissible={false} />
        <GuestSessionRefusedBanner />
      </>
    );
  }
  return children;
}

function SignedOutScreen({ message }: { message: string }) {
  return (
    <div
      data-testid="guest-refused-signed-out"
      className="flex min-h-screen items-center justify-center bg-background"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <img
          src="/mcp_jam.svg"
          alt="MCPJam"
          draggable={false}
          className="h-16 w-16"
        />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
