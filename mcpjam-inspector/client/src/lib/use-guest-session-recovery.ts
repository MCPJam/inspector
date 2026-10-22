import { useEffect, useState } from "react";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import {
  canRecoverGuestSession,
  createGuestSessionRecovery,
} from "./guest-session-recovery";

/** Restart failed guest authentication while the visitor can use the app. */
export function useGuestSessionRecovery(enabled: boolean) {
  const status = useSessionRefreshStore((state) => state.status);
  const kind = useSessionRefreshStore((state) => state.kind);
  const [recovery] = useState(createGuestSessionRecovery);

  useEffect(() => {
    if (!enabled || status !== "failed") return;
    recovery.ensureScheduled();
    if (kind !== "transient") return;

    const recover = () => {
      if (!canRecoverGuestSession() || recovery.remaining() > 0) return;
      const state = useSessionRefreshStore.getState();
      if (state.status !== "failed" || state.kind !== "transient") return;
      state.retry();
    };

    const timer = setTimeout(recover, Math.ceil(recovery.remaining()));
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [enabled, status, kind, recovery]);
  return recovery;
}
