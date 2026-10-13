import { useEffect, useRef } from "react";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

// Leave room for the four-attempt bootstrap ladder in the 10 requests/minute
// guest-session budget. Resume events share this cooldown too.
const GUEST_RECOVERY_INTERVAL_MS = 60_000;

/** Restart failed guest authentication while the visitor can use the app. */
export function useGuestSessionRecovery(enabled: boolean): void {
  const status = useSessionRefreshStore((state) => state.status);
  const kind = useSessionRefreshStore((state) => state.kind);
  const lastRecoveryAt = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || status !== "failed" || kind !== "transient") return;

    const recover = () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      const state = useSessionRefreshStore.getState();
      if (state.status !== "failed" || state.kind !== "transient") return;
      const now = performance.now();
      if (
        lastRecoveryAt.current !== null &&
        now - lastRecoveryAt.current < GUEST_RECOVERY_INTERVAL_MS
      )
        return;
      lastRecoveryAt.current = now;
      state.retry();
    };

    const timer = setTimeout(recover, GUEST_RECOVERY_INTERVAL_MS);
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [enabled, status, kind]);
}
