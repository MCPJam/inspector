import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePostHog } from "posthog-js/react";
import {
  setSessionPrivacy,
  syncSessionRecording,
  type SessionPrivacy,
} from "@/lib/session-privacy";
import { syncSentryReplay } from "@/lib/sentry";

/** A level still `pending` after this long is applied as `masked`. */
export const PRIVACY_PENDING_TIMEOUT_MS = 10_000;

/**
 * How long `masked` → `full` waits. Switching away from an organization with
 * enterprise privacy can leave its content on screen for a moment while the
 * next one loads; recording carries on masked until that has had time to go.
 */
export const MASKED_TO_FULL_SETTLE_MS = 3_000;

/**
 * Apply the session's privacy level (`resolveSessionPrivacy`) to both
 * recorders, and re-apply it whenever it changes.
 *
 * - `pending` holds both recorders off. If it is still `pending` after
 *   `PRIVACY_PENDING_TIMEOUT_MS` — the organization list failed or never
 *   came — the session is recorded `masked`. It never falls back to `full`.
 * - Toward MORE privacy (`full` → `masked`, anything → `pending`) the change
 *   lands in a layout effect: in the same commit that rendered the content
 *   the new level is for, before rrweb's mutation observer reports that
 *   content. The PostHog recorder stops first, then restarts on the masked
 *   profile, so there is no unmasked window.
 * - Toward LESS privacy (`masked` → `full`) it waits
 *   `MASKED_TO_FULL_SETTLE_MS`, recording masked meanwhile.
 */
export function useSessionPrivacy(resolved: SessionPrivacy): void {
  const posthog = usePostHog();
  const [pendingTimedOut, setPendingTimedOut] = useState(false);
  // The last level that let anything record. `pending` does not count, so
  // masked → pending → full still waits out the settle period.
  const lastRecordingLevelRef = useRef<SessionPrivacy | null>(null);

  useEffect(() => {
    if (resolved !== "pending") {
      setPendingTimedOut(false);
      return;
    }
    const timer = setTimeout(
      () => setPendingTimedOut(true),
      PRIVACY_PENDING_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [resolved]);

  const effective: SessionPrivacy =
    resolved === "pending" && pendingTimedOut ? "masked" : resolved;

  useLayoutEffect(() => {
    const apply = (level: SessionPrivacy) => {
      if (level !== "pending") lastRecordingLevelRef.current = level;
      setSessionPrivacy(level);
      // BOTH recorders, and the Sentry half even without a PostHog client:
      // PostHog is routinely ad-blocked, Sentry Replay is not gated on it.
      const pathname = window.location.pathname;
      if (posthog) syncSessionRecording(posthog, pathname);
      syncSentryReplay(pathname);
    };
    if (lastRecordingLevelRef.current === "masked" && effective === "full") {
      const timer = setTimeout(() => apply("full"), MASKED_TO_FULL_SETTLE_MS);
      return () => clearTimeout(timer);
    }
    apply(effective);
  }, [posthog, effective]);
}
