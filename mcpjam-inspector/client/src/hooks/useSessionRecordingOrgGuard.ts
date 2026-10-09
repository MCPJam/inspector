import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import {
  setOrganizationRecordingOptOut,
  syncSessionRecordingForPath,
} from "@/lib/PosthogUtils";
import { syncSentryReplayForPath } from "@/lib/sentry";

/**
 * Stop session recording while an organization in view has opted out of it,
 * and resume — only what this stopped — when the user switches away.
 *
 * `optedOut` comes from `resolveOrganizationRecordingOptOut`. `undefined`
 * means the organization list has not answered yet, and nothing changes:
 * neither recorder is touched and the remembered answer is not rewritten from
 * a guess. A returning member of an opted-out organization is covered before
 * that answer arrives by the remembered marker, which keeps both recorders
 * from being constructed at all (`shouldRecordSession`).
 *
 * Sibling of `useSessionRecordingPathGuard`, and it drives the SAME guards:
 * those hold one armed flag per recorder across both reasons, so the two
 * hooks cannot resume each other's stop. See docs/session-replay-masking.md.
 */
export function useSessionRecordingOrgGuard(
  optedOut: boolean | undefined,
): void {
  const posthog = usePostHog();

  useEffect(() => {
    if (optedOut === undefined) return;
    setOrganizationRecordingOptOut(optedOut);
    // BOTH recorders, and the Sentry half even without a PostHog client —
    // the same asymmetry, for the same reason, as the path guard.
    const pathname = window.location.pathname;
    if (posthog) syncSessionRecordingForPath(posthog, pathname);
    syncSentryReplayForPath(pathname);
  }, [posthog, optedOut]);
}
