import { useLayoutEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import {
  setSessionPrivacy,
  syncSessionRecording,
  type SessionPrivacy,
} from "@/lib/session-privacy";
import { syncSentryReplay } from "@/lib/sentry";
import { subscribeTelemetryPolicy } from "@/lib/telemetry-context";

/**
 * How long `masked` → `full` waits. Switching away from an organization with
 * enterprise privacy can leave its content on screen for a moment while the
 * next one loads; recording stays stopped until that has had time to go.
 */
export const MASKED_TO_FULL_SETTLE_MS = 3_000;

/** Tightening stops recording immediately; relaxing waits for old DOM to leave. */
export function useSessionPrivacy(
  resolved: SessionPrivacy,
  options: { contextReady?: boolean; permissionKey?: string | null } = {},
): void {
  const contextReady = options.contextReady ?? true;
  const permissionKey = options.permissionKey ?? null;
  const posthog = usePostHog();
  // A pending destination must settle before recording can restart.
  const lastRecordingLevelRef = useRef<SessionPrivacy | null>(null);

  const effective: SessionPrivacy =
    resolved === "full" && !contextReady ? "pending" : resolved;

  useLayoutEffect(() => {
    const sync = () => {
      if (posthog) syncSessionRecording(posthog, window.location);
    };
    return subscribeTelemetryPolicy(sync);
  }, [posthog]);

  useLayoutEffect(() => {
    const apply = (level: SessionPrivacy) => {
      lastRecordingLevelRef.current = level;
      setSessionPrivacy(level);
      // BOTH recorders, and the Sentry half even without a PostHog client:
      // PostHog is routinely ad-blocked, Sentry Replay is not gated on it.
      // The whole location: a secret in the query or fragment blocks
      // recording as much as one in the path.
      const { pathname, search, hash } = window.location;
      const location = { pathname, search, hash };
      if (posthog) syncSessionRecording(posthog, location);
      syncSentryReplay(location);
    };
    const leavingRestricted =
      lastRecordingLevelRef.current === "masked" ||
      lastRecordingLevelRef.current === "off" ||
      lastRecordingLevelRef.current === "pending";
    if (leavingRestricted && effective === "full") {
      const timer = setTimeout(() => apply("full"), MASKED_TO_FULL_SETTLE_MS);
      return () => clearTimeout(timer);
    }
    apply(effective);
  }, [posthog, effective, permissionKey]);
}
