import { useEffect, useRef } from "react";
import { track } from "./analytics";
import {
  currentTelemetryCaptureContext,
  subscribeTelemetryPolicy,
} from "./telemetry-context";

/**
 * How long a launch waits for the content grant before it is sent as strict.
 * The relay counts a strict launch through its closed catalog, so waiting
 * longer only buys the person profile, never the count.
 */
export const LAUNCH_POLICY_TIMEOUT_MS = 10_000;

type LaunchProperties = NonNullable<Parameters<typeof track>[1]>;

function contentGranted(): boolean {
  return currentTelemetryCaptureContext().policy.content === "full";
}

/**
 * Sends `app_launched` once the content grant settles, so a granted user's
 * launch keeps its person profile. The grant arrives after the actor is
 * known; sending at once labels every launch strict. Without a grant, the
 * timeout or `pagehide` sends it as strict instead. Sends at most once and
 * returns a cancel function.
 */
export function trackLaunchWhenPolicySettles(
  properties: LaunchProperties,
  { timeoutMs = LAUNCH_POLICY_TIMEOUT_MS }: { timeoutMs?: number } = {},
): () => void {
  let settled = false;
  let unsubscribe: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    settled = true;
    unsubscribe();
    clearTimeout(timer);
    window.removeEventListener("pagehide", send);
  };
  function send() {
    if (settled) return;
    stop();
    track("app_launched", properties);
  }

  if (contentGranted()) {
    send();
    return stop;
  }
  unsubscribe = subscribeTelemetryPolicy(() => {
    if (contentGranted()) send();
  });
  timer = setTimeout(send, timeoutMs);
  window.addEventListener("pagehide", send);
  return stop;
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
  const cancelPendingRef = useRef<(() => void) | null>(null);
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
