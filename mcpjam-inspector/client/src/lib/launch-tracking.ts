import { useEffect, useRef } from "react";
import { track } from "./analytics";
import {
  currentTelemetryCaptureContext,
  subscribeTelemetryPolicy,
} from "./telemetry-context";

/**
 * The longest a launch waits for the content grant before it is sent as
 * strict. A ceiling, not the expected wait: the relay counts a strict launch
 * through its closed catalog, so waiting only buys the person profile, never
 * the count. Each launch reports `launch_trigger` and `policy_wait_ms` so the
 * real grant latency can be measured and this ceiling tuned.
 */
export const LAUNCH_POLICY_TIMEOUT_MS = 10_000;

type LaunchProperties = NonNullable<Parameters<typeof track>[1]>;

/** What sent the launch. Closed values, mirrored in the strict catalog. */
export type LaunchTrigger = "immediate" | "grant" | "timeout" | "hidden";

function contentGranted(): boolean {
  return currentTelemetryCaptureContext().policy.content === "full";
}

/**
 * Sends `app_launched` once the content grant settles, so a granted user's
 * launch keeps its person profile. The grant arrives after the actor is
 * known; sending at once labels every launch strict. Without a grant, the
 * timeout or the page going hidden sends it as strict instead.
 *
 * The hidden fallback listens for `visibilitychange`, not only `pagehide`.
 * posthog-js registers its own `pagehide` handler at init and flushes its
 * queue there. This listener is added later, once the actor resolves, so a
 * `pagehide` listener alone would enqueue the launch after PostHog's flush
 * and it would never leave the page. `visibilitychange` fires before
 * `pagehide`, so PostHog's unload flush carries the launch. `pagehide` stays
 * as a fallback for browsers that skip `visibilitychange` on close; sending
 * is idempotent.
 *
 * Sends at most once. Returns a cancel function that reports whether it
 * stopped a launch that had not been sent yet.
 */
export function trackLaunchWhenPolicySettles(
  properties: LaunchProperties,
  { timeoutMs = LAUNCH_POLICY_TIMEOUT_MS }: { timeoutMs?: number } = {},
): () => boolean {
  const startedAt = Date.now();
  let settled = false;
  let unsubscribe: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") send("hidden");
  };
  const onPageHide = () => send("hidden");
  const stop = () => {
    settled = true;
    unsubscribe();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
  };
  function send(trigger: LaunchTrigger) {
    if (settled) return;
    stop();
    track("app_launched", {
      ...properties,
      launch_trigger: trigger,
      policy_wait_ms: Math.max(0, Date.now() - startedAt),
    });
  }
  const cancel = () => {
    if (settled) return false;
    stop();
    return true;
  };

  if (contentGranted()) {
    send("immediate");
    return cancel;
  }
  unsubscribe = subscribeTelemetryPolicy(() => {
    if (contentGranted()) send("grant");
  });
  timer = setTimeout(() => send("timeout"), timeoutMs);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  return cancel;
}

/**
 * One `app_launched` per actor. A pending launch is cancelled only when the
 * actor changes, not when other props re-run the effect: the guard would
 * otherwise block the resend and lose the launch.
 */
export function useAppLaunchedEvent(
  actorKey: string | null | undefined,
  isAuthenticated: boolean,
): void {
  const lastActorRef = useRef<string | null>(null);
  const cancelPendingRef = useRef<(() => boolean) | null>(null);
  // Unmount-only cleanup, kept apart from the actor effect so prop changes
  // never cancel a pending launch. When it cancels a launch that was not sent
  // yet, it also clears the actor guard: under StrictMode the dev double-mount
  // runs this cleanup, and a stale guard would stop the remount from resending
  // it. A launch that was already sent keeps the guard, so effects restored on
  // the same instance do not send it twice.
  useEffect(
    () => () => {
      const cancelledUnsent = cancelPendingRef.current?.() ?? false;
      cancelPendingRef.current = null;
      if (cancelledUnsent) lastActorRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!actorKey || lastActorRef.current === actorKey) return;
    lastActorRef.current = actorKey;
    cancelPendingRef.current?.();
    cancelPendingRef.current = trackLaunchWhenPolicySettles({
      location: "app",
      user_agent: navigator.userAgent,
      version: __APP_VERSION__,
      is_authenticated: isAuthenticated,
    });
  }, [actorKey, isAuthenticated]);
}
