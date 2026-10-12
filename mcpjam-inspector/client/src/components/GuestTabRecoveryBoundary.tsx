import {
  projectTransitionRecovery,
  currentProjectTransitionPath,
} from "@/lib/auth/project-transition-recovery";
import { authRefusalDiagnostics } from "@/lib/auth/auth-refusal-diagnostics";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { useStore } from "zustand";
import { useAuth } from "@workos-inc/authkit-react";
import { useActorKey } from "@/hooks/use-actor-key";
import {
  guestTabRecovery,
  listenForGuestTransitions,
  readGuestTransition,
} from "@/lib/auth/guest-tab-recovery";
import { Button } from "@mcpjam/design-system/button";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import LoadingScreen from "./LoadingScreen";

/** Mounted below auth providers and above every protected app subscription. */
export function GuestTabRecoveryBoundary({
  children,
  ready = true,
}: {
  children: ReactNode;
  ready?: boolean;
}) {
  const { user, isLoading, signIn } = useAuth();
  const actor = useActorKey();
  const { isAuthenticated, isLoading: convexLoading } = useConvexAuth();
  const confirmed = useSessionRefreshStore((s) => s.authConfirmed);
  const status = useStore(guestTabRecovery.store, (s) => s.status);
  useLayoutEffect(() => {
    if (isLoading || (!user && !actor)) return;
    guestTabRecovery.setGuest(
      !user ? actor : null,
      ready && isAuthenticated && !convexLoading && confirmed,
    );
  }, [
    actor,
    isLoading,
    user?.id,
    ready,
    isAuthenticated,
    convexLoading,
    confirmed,
  ]);
  useEffect(() => {
    const update = () => {
      const state = useSessionRefreshStore.getState();
      authRefusalDiagnostics.update({
        mode: user ? "workos" : actor ? "guest" : "unknown",
        authenticated: state.authConfirmed,
        epoch: state.authEpoch,
        recoveryId: state.recoveryId,
        blocked: status !== "idle" || state.queriesPaused,
      });
    };
    update();
    return useSessionRefreshStore.subscribe(update);
  }, [actor, user?.id, status]);
  useEffect(() => readGuestTransition(), [actor, isLoading, user?.id]);
  if (status === "idle") return children;
  return (
    <>
      <LoadingScreen message="Updating your session…" />
      {status === "failed" && (
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-border bg-background px-4 py-2 text-sm"
        >
          <span>Couldn't update your session.</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => guestTabRecovery.retry()}
          >
            Retry
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              captureAppSignInReturnPath();
              void Promise.resolve(signIn(permalinkSignInOptions())).catch(
                () => {},
              );
            }}
          >
            Sign in
          </Button>
        </div>
      )}
    </>
  );
}

/** Listen even while Convex's boundary is waiting for authentication. */
export function GuestTabTransitionListener() {
  const { user, isLoading } = useAuth();
  const actor = useActorKey();
  useLayoutEffect(() => {
    if (isLoading || (!user && !actor)) return;
    projectTransitionRecovery.observeActor(
      user ? `workos:${user.id}` : `guest:${actor}`,
      currentProjectTransitionPath(),
    );
    // Invalidate the old guest even while Convex has unmounted the app gate.
    // Only the gate, after setup succeeds, may release a pending recovery.
    guestTabRecovery.setGuest(user ? null : actor, false);
  }, [actor, isLoading, user?.id]);
  useEffect(() => {
    const stop = listenForGuestTransitions();
    window.addEventListener("pagehide", authRefusalDiagnostics.flush);
    return () => {
      stop();
      window.removeEventListener("pagehide", authRefusalDiagnostics.flush);
    };
  }, []);
  return null;
}
