/**
 * A Send that meets a box a preparation is still setting up.
 *
 * While `prepare-conversation-box.ts` holds a box's claim, the backend answers
 * any other run's claim or lease start `box_preparing`, with the claim's
 * expiry. The Send keeps retrying, with backoff, while that expiry keeps
 * moving on (the preparer renews it), for at most `BOX_PREPARING_WAIT_MS`:
 * the preparation's own deadline and a margin. An expiry that stops moving
 * means the preparer died, and its claim holds until its TTL: the Send never
 * runs beside it. Either way the Send stops before any sandbox command, with
 * an error the person can retry; a retry once the claim has lapsed proceeds.
 */
import { HarnessInfraSetupError } from "./harness-provider-error.js";
import {
  CLAIM_CALL_TIMEOUT_MS,
  CLAIM_RENEWAL_MS,
  PREPARATION_DEADLINE_MS,
} from "./preparation-timing.js";

// Mirrored by the backend's `BOX_PREPARING_CODE`, pinned by its check:mirrors.
export const BOX_PREPARING_CODE = "box_preparing";
/** The longest a Send waits on a preparation: its deadline and a margin. */
export const BOX_PREPARING_WAIT_MS = PREPARATION_DEADLINE_MS + 30_000;
/** A live preparer renews within this; an expiry still for longer stopped. */
export const STALLED_CLAIM_MS =
  CLAIM_RENEWAL_MS + CLAIM_CALL_TIMEOUT_MS + 15_000;

type Attempt<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Run `attempt` (a claim or a lease start) until it answers anything but
 * `box_preparing`, waiting between tries while the preparation lives. Each try
 * gets the caller's cancellation and the time left; one cut off by the time,
 * or a preparation that outlasts the wait, ends in a typed, retryable error.
 * A try cut off may still have succeeded at the backend: the caller undoes it.
 */
export async function waitOutBoxPreparation<
  T extends { ok: boolean; code?: string; reservationExpiresAt?: number },
>(attempt: Attempt<T>, signal?: AbortSignal): Promise<T> {
  const giveUpAt = performance.now() + BOX_PREPARING_WAIT_MS;
  let expiry: number | undefined;
  let movedAt = performance.now();
  for (let tries = 0; ; tries++) {
    const result = await attemptWithin(attempt, giveUpAt, signal);
    if (result.ok || result.code !== BOX_PREPARING_CODE) return result;
    const now = performance.now();
    const seen = result.reservationExpiresAt;
    if (seen !== undefined && (expiry === undefined || seen > expiry)) {
      expiry = seen;
      movedAt = now;
    }
    const pause = Math.min(500 * 2 ** tries, 4_000);
    if (now + pause >= giveUpAt || now - movedAt > STALLED_CLAIM_MS) {
      throw stillPreparing();
    }
    await sleep(pause, signal);
  }
}

async function attemptWithin<T>(
  attempt: Attempt<T>,
  giveUpAt: number,
  caller?: AbortSignal,
): Promise<T> {
  const bound = new AbortController();
  const timer = setTimeout(
    () => bound.abort(stillPreparing()),
    Math.max(0, giveUpAt - performance.now()),
  );
  try {
    const result = await attempt(
      caller ? AbortSignal.any([caller, bound.signal]) : bound.signal,
    );
    if (bound.signal.aborted && !caller?.aborted) throw stillPreparing();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function stillPreparing(): HarnessInfraSetupError {
  return new HarnessInfraSetupError(
    "This conversation's computer is still being set up. Send your message again in a moment.",
    { source: "sandbox_setup", code: BOX_PREPARING_CODE, httpStatus: 409 },
  );
}

/** On the global timer, so a test's fake clock drives the wait. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
