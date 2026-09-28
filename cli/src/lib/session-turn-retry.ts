import { setTimeout as delay } from "node:timers/promises";
import { isPlatformApiError } from "@mcpjam/sdk/platform";

/** Recheck admission with the same request; never replay an unknown execution. */
export async function waitForSessionTurn<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = async (
    ms,
    signal
  ) => {
    await delay(ms, undefined, { signal });
  }
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      if (
        !isPlatformApiError(error) ||
        error.status !== 409 ||
        error.details?.reason !== "TURN_IN_PROGRESS"
      )
        throw error;
      const retryAfterMs = error.details.retryAfterMs;
      if (
        typeof retryAfterMs !== "number" ||
        !Number.isFinite(retryAfterMs) ||
        retryAfterMs <= 0
      )
        throw error;
      await wait(retryAfterMs, signal);
    }
  }
}
