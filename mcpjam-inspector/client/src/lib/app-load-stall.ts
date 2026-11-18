import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "./config";
import { reportCaught } from "./error-reporting";
import { getGuestSessionRefusal } from "./guest-session";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import {
  APP_LOAD_STALL_MS,
  appLoadStallCode,
} from "@/shared/app-load-stall";

/**
 * Reported when the app never became usable on this page load. The failure
 * that caused it may have thrown nothing, or been reported under a name that
 * does not say the user is stuck; this names the symptom and the stuck step.
 */
export class AppLoadStalledError extends Error {
  constructor() {
    super("The app did not finish loading");
    this.name = "AppLoadStalledError";
  }
}

// Once per page load: after the first time the app is usable, a later
// sign-out or identity switch is not a failed load.
let settled = false;

/**
 * Report once if `ready` has not become true within `APP_LOAD_STALL_MS` of the
 * page starting. Self-hosted only (npm, Docker, desktop): there the user's own
 * network decides whether the embedded server can reach MCPJam, and nothing on
 * our side sees it fail. `identityKnown` is whether an actor (signed-in user or
 * guest) has resolved, which splits a missing actor from a slow user setup.
 */
export function useAppLoadStallReport(
  ready: boolean,
  identityKnown: boolean,
): void {
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (ready) settled = true;
    if (settled || HOSTED_MODE) return;
    const elapsed = typeof performance === "undefined" ? 0 : performance.now();
    const timer = window.setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reportCaught(new AppLoadStalledError(), {
          source: "app_load_stall",
          level: "error",
          extra: {
            code: appLoadStallCode({
              guestRefused: getGuestSessionRefusal() !== null,
              sessionRefreshFailed:
                useSessionRefreshStore.getState().status !== "idle",
              authenticated: isAuthenticated,
              identityKnown,
            }),
          },
        });
      },
      Math.max(0, APP_LOAD_STALL_MS - elapsed),
    );
    return () => window.clearTimeout(timer);
  }, [ready, isAuthenticated, identityKnown]);
}

/** Test seam: each test is its own page load. */
export function resetAppLoadStallForTests(): void {
  settled = false;
}
