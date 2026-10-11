import { useLayoutEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import {
  setSessionPrivacy,
  syncSessionRecording,
  type SessionPrivacy,
} from "@/lib/session-privacy";
import { syncSentryReplay } from "@/lib/sentry";

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
 * - `pending` at startup holds both recorders off for as long as it lasts:
 *   a backend that never answers, or fails, never starts a replay. Only an
 *   answer can permit recording, because only an answer can say the
 *   organization has replay `off`.
 * - `pending` after an answer has let the session record — navigating to a
 *   context whose answer has not arrived — records `masked` at once rather
 *   than stopping: the destination is unknown, so it is treated as private.
 *   Replay `off` follows membership, so on an organization's own pages
 *   anyone it applies to was already answered `off`. That holds only for
 *   the actor and memberships the earlier answer was for (`permissionKey`):
 *   after a sign-in change or a membership reload — joining an organization
 *   with replay off, say — `pending` stops both recorders until the new
 *   answer arrives.
 * - Toward MORE privacy (`full` → `masked`, anything → `pending`) the change
 *   lands in a layout effect: in the same commit that rendered the content
 *   the new level is for, before rrweb's mutation observer reports that
 *   content. The PostHog recorder stops first, then restarts on the masked
 *   profile, so there is no unmasked window.
 * - Toward LESS privacy (`masked` or `off` → `full`) the destination must
 *   have resolved to `full` AND finished loading (`contextReady`), and then
 *   it still waits `MASKED_TO_FULL_SETTLE_MS` under the previous level: the
 *   last organization's content can still be on screen.
 */
export function useSessionPrivacy(
  resolved: SessionPrivacy,
  options: { contextReady?: boolean; permissionKey?: string | null } = {},
): void {
  const contextReady = options.contextReady ?? true;
  const permissionKey = options.permissionKey ?? null;
  const posthog = usePostHog();
  // The last level that let anything record. `pending` does not count, so
  // masked → pending → full still waits out the settle period.
  const lastRecordingLevelRef = useRef<SessionPrivacy | null>(null);
  // The scope that level was answered for.
  const permittedForRef = useRef<string | null>(null);

  const hasRecorded =
    permittedForRef.current === permissionKey &&
    (lastRecordingLevelRef.current === "masked" ||
      lastRecordingLevelRef.current === "full");
  let effective: SessionPrivacy = resolved;
  if (resolved === "pending" && hasRecorded) {
    effective = "masked";
  } else if (resolved === "full" && !contextReady) {
    effective = "masked";
  }

  useLayoutEffect(() => {
    const apply = (level: SessionPrivacy) => {
      if (level !== "pending") {
        lastRecordingLevelRef.current = level;
        permittedForRef.current = permissionKey;
      }
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
      lastRecordingLevelRef.current === "off";
    if (leavingRestricted && effective === "full") {
      const timer = setTimeout(() => apply("full"), MASKED_TO_FULL_SETTLE_MS);
      return () => clearTimeout(timer);
    }
    apply(effective);
  }, [posthog, effective, permissionKey]);
}
