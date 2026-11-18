import { useEffect } from "react";
import { STRICT_COUNT_MAX } from "@/shared/strict-posthog";
import { track } from "./analytics";
import type { StartupStatus } from "./startup-status";

// Once per page load each. StrictMode remounts and reconnects re-run the
// effects below, and neither is a new launch or a new block.
let startedSent = false;
let blockedSent = false;

/**
 * Count launches before any actor is known. `app_startup_started` goes out on
 * the first render inside `PostHogProvider`; `app_startup_blocked` goes out
 * the first time the recovery card replaces the spinner, with the stage it is
 * stuck on and whether a reported failure or the deadline put it there.
 * Their ratio, by version and platform, is the share of stuck launches.
 */
export function useStartupTracking(
  status: StartupStatus,
  userReady: boolean,
): void {
  useEffect(() => {
    if (startedSent) return;
    // PostHogProvider calls posthog.init in its own effect, and React runs a
    // child's effects before its parent's: a capture from here would reach an
    // uninitialized client and be dropped. Send on the next task instead.
    const timer = setTimeout(() => {
      if (startedSent) return;
      startedSent = true;
      track("app_startup_started", { location: "app" });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const { escalated, stage, failureKind } = status;
  useEffect(() => {
    // Once the app has been usable, a later failure is a broken session, not a
    // stuck launch: it must not count toward the blocked share.
    if (userReady) blockedSent = true;
    if (!escalated || blockedSent) return;
    blockedSent = true;
    track("app_startup_blocked", {
      location: "app",
      stage,
      trigger: failureKind ? "failure" : "deadline",
      // The strict relay drops counts above its cap; a tab left open that
      // long still belongs in the top bucket, so clamp rather than lose it.
      elapsed_ms: Math.min(
        typeof performance === "undefined" ? 0 : Math.round(performance.now()),
        STRICT_COUNT_MAX,
      ),
    });
  }, [userReady, escalated, stage, failureKind]);
}

/** Test seam: each test is its own page load. */
export function resetStartupTrackingForTests(): void {
  startedSent = false;
  blockedSent = false;
}
