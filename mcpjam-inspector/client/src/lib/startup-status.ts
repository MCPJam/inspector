import { useEffect, useSyncExternalStore } from "react";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { useAppLoadStallReport } from "./app-load-stall";
import { useStartupTracking } from "./startup-tracking";
import { recordDesktopActivity } from "./desktop-diagnostics";
import { useConvexAuth } from "convex/react";
import { create } from "zustand";
import {
  STARTUP_RECOVERY_DEADLINE_MS,
  appLoadStallCode,
  type AppLoadStallCode,
} from "@/shared/app-load-stall";
import { shouldSkipGuestSession } from "./vanity-landing-hosts";
import {
  getGuestSessionRefusal,
  subscribeGuestSessionChanges,
  type GuestSessionRefusalReason,
} from "./guest-session";
import {
  useSessionRefreshStore,
  type SessionRefreshFailureKind,
} from "@/stores/session-refresh-store";

/**
 * Whether startup has stalled long enough, or failed clearly enough, that the
 * user should get recovery actions instead of a spinner.
 *
 * Startup is gated twice: an outer `AuthRecoveryBoundary` holds the whole app
 * until Convex is authenticated, and `AuthBootstrap` (inside it) then waits
 * for the user record. When a session refresh fails, the outer gate blocks and
 * `AuthBootstrap` never mounts, so this state lives in a store that the
 * tracker below drives from above both gates. `AuthBootstrap` only adds
 * whether the user record is ready.
 */
interface StartupState {
  userReady: boolean;
  identityKnown: boolean;
  deadlinePassed: boolean;
  escalated: boolean;
  /**
   * The last refresh failure seen during this startup. A guest Retry clears
   * the refresh store while it runs, so the card would otherwise forget what
   * failed and fall back to the slow-startup message.
   */
  lastFailureKind: SessionRefreshFailureKind | null;
  /** Retry was pressed and no new failure or readiness has arrived yet. */
  retryPending: boolean;
}

const INITIAL: StartupState = {
  userReady: false,
  identityKnown: false,
  deadlinePassed: false,
  escalated: false,
  lastFailureKind: null,
  retryPending: false,
};

export const useStartupStore = create<StartupState>(() => INITIAL);

/** The recovery card's Retry: an in-place re-authentication, shown as busy. */
export function retryStartup(): void {
  useStartupStore.setState({ retryPending: true });
  useSessionRefreshStore.getState().retry();
}

// Once per page load: after the app has been usable once, a later sign-out or
// reconnect is not a stalled startup, so the deadline no longer applies.
let startupSettled = false;

/** Called by `AuthBootstrap`, which mounts only after Convex authenticates. */
export function reportUserReadiness(
  userReady: boolean,
  identityKnown: boolean,
): void {
  if (userReady) startupSettled = true;
  useStartupStore.setState({ userReady, identityKnown });
}

/**
 * Mount once, above the outer `AuthRecoveryBoundary`. Starts the deadline and
 * keeps `escalated` set from the first failure or deadline until the user
 * record is ready, so a Retry in progress keeps the recovery card on screen.
 */
export function StartupStatusTracker(): null {
  const { isAuthenticated } = useConvexAuth();
  const userReady = useStartupStore((s) => s.userReady);
  const deadlinePassed = useStartupStore((s) => s.deadlinePassed);
  const failed = useSessionRefreshStore((s) => s.status !== "idle");
  const failedNow = useSessionRefreshStore((s) => s.status === "failed");
  const kind = useSessionRefreshStore((s) => s.kind);
  const status = useStartupStatus();
  // `/redeem` and the caniuse host work signed out by design, so a visitor
  // there never gets a user record. That is not a stalled startup.
  const publicPage = !isAuthenticated && shouldSkipGuestSession();
  useAppLoadStallReport(userReady || publicPage, status.stage);
  useStartupTracking(status, userReady);

  // The desktop Help menu reads this from the main process, which still works
  // when this window is stuck. It is the only renderer heartbeat, and it runs
  // while startup is blocked and App has not mounted.
  const { user, isLoading: workOsLoading } = useInspectorAuth();
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!window.electronAPI?.diagnostics) return;
    const report = () =>
      recordDesktopActivity({
        kind: "startup",
        phase: "state",
        stage: userReady ? "ready" : status.stage,
        auth: workOsLoading ? "loading" : signedIn ? "signed_in" : "guest",
        version: __APP_VERSION__,
      });
    report();
    const timer = setInterval(report, 15_000);
    return () => clearInterval(timer);
  }, [userReady, status.stage, signedIn, workOsLoading]);

  useEffect(() => {
    if (startupSettled) return;
    const elapsed = typeof performance === "undefined" ? 0 : performance.now();
    const timer = window.setTimeout(
      () => useStartupStore.setState({ deadlinePassed: true }),
      Math.max(0, STARTUP_RECOVERY_DEADLINE_MS - elapsed),
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (failedNow && kind) {
      useStartupStore.setState({ lastFailureKind: kind, retryPending: false });
    }
  }, [failedNow, kind]);

  // Once Convex accepts a token again, the failure is over even if the user
  // record is still on its way: the card should name that step, and Retry
  // should not stay busy waiting for a readiness that is a different problem.
  const authRecovered = isAuthenticated && !failed;
  useEffect(() => {
    if (authRecovered) {
      useStartupStore.setState({ lastFailureKind: null, retryPending: false });
    }
  }, [authRecovered]);

  useEffect(() => {
    if (userReady || publicPage) {
      useStartupStore.setState({
        escalated: false,
        lastFailureKind: null,
        retryPending: false,
      });
      return;
    }
    if (failed || (deadlinePassed && !startupSettled)) {
      useStartupStore.setState({ escalated: true });
    }
  }, [userReady, publicPage, failed, deadlinePassed]);

  return null;
}

export interface StartupStatus {
  escalated: boolean;
  stage: AppLoadStallCode;
  failureKind: SessionRefreshFailureKind | null;
  /** Set when the guest authority refused a new guest; retrying cannot help. */
  refusalReason: GuestSessionRefusalReason | null;
  retrying: boolean;
}

/** Read by both startup gates and by the app's own startup spinners. */
export function useStartupStatus(): StartupStatus {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useInspectorAuth();
  const escalated = useStartupStore((s) => s.escalated);
  const identityKnown = useStartupStore((s) => s.identityKnown);
  const lastFailureKind = useStartupStore((s) => s.lastFailureKind);
  const retryPending = useStartupStore((s) => s.retryPending);
  const status = useSessionRefreshStore((s) => s.status);
  const kind = useSessionRefreshStore((s) => s.kind);
  const failureKind = (status === "idle" ? null : kind) ?? lastFailureKind;
  const refusal = useSyncExternalStore(
    subscribeGuestSessionChanges,
    getGuestSessionRefusal,
    () => null,
  );
  return {
    escalated,
    stage: appLoadStallCode({
      guestRefused: refusal !== null,
      sessionRefreshFailed: failureKind !== null,
      signedIn: Boolean(user),
      authenticated: isAuthenticated,
      identityKnown,
    }),
    failureKind,
    refusalReason: refusal?.reason ?? null,
    retrying: status === "retrying" || retryPending,
  };
}

/** Test seam: each test is its own page load. */
export function resetStartupStatusForTests(): void {
  startupSettled = false;
  useStartupStore.setState(INITIAL);
}
