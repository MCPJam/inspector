/**
 * Retry a `/stream` request the backend refused as `spending_reservation_busy`.
 *
 * That refusal is decided BEFORE any provider call: the org's spending lane
 * could not admit the request in time, the model was not called and nothing
 * was charged. Sending the same step again is therefore safe — no tool runs
 * again and no turn is replayed — which is not true of any other failure.
 *
 * The wait is bounded by the caller's abort signal (the turn deadline, which
 * nests under the iteration and run deadlines and the run's cancel), so a
 * retry never outlives the time the trial was given. Each attempt goes back
 * through the backend's own admission, which rechecks authorization.
 */
export const SPENDING_RESERVATION_BUSY = "spending_reservation_busy";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_DELAY_MS = 2_000;
const MAX_DELAY_MS = 8_000;

/** The refusal's suggested wait, or null when this is not a busy refusal. */
export async function busyRetryAfterMs(res: Response): Promise<number | null> {
  if (res.status !== 503) return null;
  let body: { code?: unknown; retryAfter?: unknown };
  try {
    body = JSON.parse(await res.clone().text());
  } catch {
    return null;
  }
  if (body?.code !== SPENDING_RESERVATION_BUSY) return null;
  return typeof body.retryAfter === "number" && body.retryAfter > 0
    ? body.retryAfter
    : DEFAULT_DELAY_MS;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Send again while the answer is a busy refusal. Returns the first other
 * answer, or the last busy one once attempts run out. Throws the signal's
 * reason when the deadline or a cancel lands while waiting.
 */
export async function retryWhileSpendingBusy(
  first: Response,
  send: () => Promise<Response>,
  opts: {
    signal?: AbortSignal;
    maxAttempts?: number;
    onRetry?: (attempt: number, delayMs: number) => void;
  } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let res = first;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const suggested = await busyRetryAfterMs(res);
    if (suggested === null) return res;
    const backoff = Math.min(suggested * attempt, MAX_DELAY_MS);
    // Full jitter around the backoff, so a burst does not retry in step.
    const delayMs = Math.round(backoff * (0.5 + Math.random() * 0.5));
    opts.onRetry?.(attempt, delayMs);
    try {
      await res.body?.cancel();
    } catch {
      // Already read by the clone or closed; nothing to release.
    }
    await waitFor(delayMs, opts.signal);
    res = await send();
  }
  return res;
}
