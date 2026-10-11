import { useEffect, useRef } from "react";

/** Observes initial rendering only; visibility and subsequent interactions are not launches. */
export function useInitialRenderOutcome(
  ready: boolean,
  failed: boolean,
  notify?: (outcome: "ready" | "error") => void
): void {
  const delivered = useRef(false);
  const callback = useRef(notify);
  callback.current = notify;
  useEffect(() => {
    if (delivered.current || (!ready && !failed) || !callback.current) return;
    delivered.current = true;
    // Telemetry must never break rendering or cause an effect to be retried.
    try {
      callback.current(failed ? "error" : "ready");
    } catch {
      // Best effort observer.
    }
  }, [ready, failed, notify]);
}
