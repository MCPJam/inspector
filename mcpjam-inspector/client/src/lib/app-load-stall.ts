import { useEffect, useRef } from "react";
import { reportCaught } from "./error-reporting";
import {
  APP_LOAD_STALL_MS,
  type AppLoadStallCode,
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
 * page starting, on every deployment. Nothing on our side sees a stuck load
 * fail: on self-hosted installs the user's own network decides whether the
 * embedded server can reach MCPJam, and on the hosted app the browser can still
 * stall on auth. The `deployment` tag on every event separates the two.
 *
 * `stage` comes from `useStartupStatus`, so this report, the recovery card and
 * the copied diagnostics all name the same step. It is read when the timer
 * fires, not when it starts.
 */
export function useAppLoadStallReport(
  ready: boolean,
  stage: AppLoadStallCode,
): void {
  const stageRef = useRef(stage);
  stageRef.current = stage;

  useEffect(() => {
    if (ready) settled = true;
    if (settled) return;
    const elapsed = typeof performance === "undefined" ? 0 : performance.now();
    const timer = window.setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reportCaught(new AppLoadStalledError(), {
          source: "app_load_stall",
          level: "error",
          extra: { code: stageRef.current },
        });
      },
      Math.max(0, APP_LOAD_STALL_MS - elapsed),
    );
    return () => window.clearTimeout(timer);
  }, [ready]);
}

/** Test seam: each test is its own page load. */
export function resetAppLoadStallForTests(): void {
  settled = false;
}
