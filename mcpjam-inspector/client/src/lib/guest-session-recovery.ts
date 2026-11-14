const RECOVERY_WAITS_MS = [60_000, 120_000, 240_000, 300_000] as const;
const RECOVERY_JITTER_MS = 15_000;

export function canRecoverGuestSession(): boolean {
  return document.visibilityState !== "hidden" && navigator.onLine;
}

/** Wait for both the shared deadline and a usable foreground app. */
function waitForRecovery(
  deadline: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    const check = () => {
      if (signal.aborted) return abort();
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        clearTimeout(timer);
        timer = setTimeout(check, Math.ceil(remaining));
      } else if (canRecoverGuestSession()) finish(true);
    };
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

/** One outage's backoff and reporting budget, shared by every retry trigger. */
export function createGuestSessionRecovery() {
  let step = 0;
  let deadline: number | null = null;
  let reported = false;
  const schedule = () => {
    deadline =
      performance.now() +
      RECOVERY_WAITS_MS[step] +
      Math.random() * RECOVERY_JITTER_MS;
    step = Math.min(step + 1, RECOVERY_WAITS_MS.length - 1);
  };
  return {
    failed: () => {
      schedule();
      const shouldReport = !reported;
      reported = true;
      return shouldReport;
    },
    // A failed guest token refresh can enter recovery before startup does.
    ensureScheduled: () => {
      if (deadline === null) schedule();
    },
    remaining: () => Math.max(0, (deadline ?? 0) - performance.now()),
    wait: (signal: AbortSignal) =>
      deadline === null
        ? Promise.resolve(!signal.aborted)
        : waitForRecovery(deadline, signal),
    reset: () => {
      step = 0;
      deadline = null;
      reported = false;
    },
  };
}
