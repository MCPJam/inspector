/**
 * Elicitation-aware timeout suspension for `tools/call`.
 *
 * The per-request MCP timeout is a *server* budget: it exists to kill a hung
 * server. A tool call that is blocked because the server asked the user a
 * question is not hung — the clock should stop while a human is thinking.
 *
 * Upstream enforces `RequestOptions.timeout` itself and has no notion of
 * "suspended", so this module raises the upstream hard timeout out of the way
 * (`base + extension`) and re-implements the budget locally with a watchdog
 * that tracks two clocks:
 *
 *  - **active**: accumulates only while NO elicitation is pending for the
 *    server. Exhausting it at `base` means the server really is hung.
 *  - **suspended**: accumulates only while an elicitation IS pending, and is
 *    cumulative across every elicitation in the call. Exhausting it at
 *    `extension` means the human never finished. This is the TOTAL elicitation
 *    budget for one tool call; each individual elicitation is additionally
 *    bounded by whatever TTL the callback implementation enforces.
 *
 * Either exhaustion aborts the call with a timeout-shaped `SdkError`, so
 * callers see a timeout rather than a bare `AbortError`. The watchdog signal is
 * COMPOSED with the caller's signal (never clobbers it): the AI SDK forwards
 * its own `abortSignal` into `executeTool` request options.
 *
 * Known conservative edge: pending state is tracked per SERVER, not per call.
 * A second, unrelated tool call in flight on the same server while an
 * elicitation is pending also has its active clock paused. It stays bounded by
 * its own suspended budget, so it still terminates — just later than a strict
 * per-call accounting would.
 */

import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { markNonRetryableError } from "./error-utils.js";

/** How often the watchdog samples the pending state. */
export const ELICITATION_WATCHDOG_INTERVAL_MS = 1000;

export interface ElicitationTimeoutSuspensionOptions {
  /** Server the tool call targets (for error messages). */
  serverId: string;
  /** Active-time budget, i.e. the timeout the call would have had. */
  baseTimeoutMs: number;
  /** Cumulative suspended-time budget for the whole call. */
  extensionMs: number;
  /** Whether an elicitation is currently pending for this server. */
  hasPending: () => boolean;
  /** The caller's abort signal, if any. Composed, never replaced. */
  callerSignal?: AbortSignal;
  /** Watchdog sampling interval. Defaults to {@link ELICITATION_WATCHDOG_INTERVAL_MS}. */
  intervalMs?: number;
}

export interface ElicitationTimeoutSuspension {
  /** Signal to hand to the MCP request. Composed of caller + watchdog. */
  signal: AbortSignal;
  /** The hard timeout to hand to the MCP request (`base + extension`). */
  timeoutMs: number;
  /** Clears the interval and removes any listeners. Idempotent. */
  dispose(): void;
}

/**
 * Composes abort signals, preferring the platform `AbortSignal.any`.
 *
 * The package's engines floor is `node >= 20.0.0` but `AbortSignal.any` only
 * landed in Node 20.3.0, so this feature-detects and hand-rolls forwarding on
 * older runtimes rather than raising the floor (which would be a breaking
 * change to a published package).
 */
function composeAbortSignals(signals: AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  if (signals.length === 1) {
    return { signal: signals[0], dispose: () => {} };
  }

  const nativeAny = (
    AbortSignal as unknown as {
      any?: (signals: Iterable<AbortSignal>) => AbortSignal;
    }
  ).any;
  if (typeof nativeAny === "function") {
    // `AbortSignal.any` holds its sources weakly and needs no teardown.
    return { signal: nativeAny.call(AbortSignal, signals), dispose: () => {} };
  }

  // Node 20.0–20.2 fallback: forward manually.
  const controller = new AbortController();
  const teardown: Array<() => void> = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener("abort", onAbort, { once: true });
    teardown.push(() => source.removeEventListener("abort", onAbort));
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const off of teardown) off();
      teardown.length = 0;
    },
  };
}

/**
 * Builds the timeout-shaped error the watchdog aborts with.
 *
 * Shape matches what upstream raises on its own timeouts
 * (`SdkError` / `SdkErrorCode.RequestTimeout`), so existing timeout handling
 * keeps working. Marked non-retryable: the message unavoidably says "timed
 * out", which `isRetryableTransientError` would otherwise treat as transient.
 */
export function createElicitationTimeoutError(
  message: string,
  data: Record<string, unknown>
): SdkError {
  return markNonRetryableError(
    new SdkError(SdkErrorCode.RequestTimeout, message, data)
  );
}

/**
 * Creates a watchdog enforcing the active/suspended budgets for one tool call.
 *
 * Caller MUST call {@link ElicitationTimeoutSuspension.dispose} in a `finally`.
 */
export function createElicitationTimeoutSuspension(
  options: ElicitationTimeoutSuspensionOptions
): ElicitationTimeoutSuspension {
  const {
    serverId,
    baseTimeoutMs,
    extensionMs,
    hasPending,
    callerSignal,
    intervalMs = ELICITATION_WATCHDOG_INTERVAL_MS,
  } = options;

  const watchdog = new AbortController();
  let activeMs = 0;
  let suspendedMs = 0;
  let lastSampleAt = Date.now();
  let disposed = false;

  const abortWith = (error: SdkError) => {
    if (watchdog.signal.aborted) return;
    watchdog.abort(error);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Sample interval for the NEXT check.
   *
   * A fixed 1s cadence silently broke short per-call timeouts: we raise the
   * upstream timeout to `base + extension` immediately, so a caller asking for
   * 100ms would not be stopped until our first sample at 1s — a 10x overrun of
   * a budget the caller explicitly set.
   *
   * We cannot schedule a single one-shot at the full remaining budget instead:
   * `hasPending()` is a poll, so we must keep looking often enough to notice an
   * elicitation *starting* and stop counting its wait as server time.
   *
   * So: sample at the cap, or at whatever budget remains if that is sooner.
   * Overshoot is bounded by one interval, which is now always ≤ the budget
   * itself — 120s budgets still sample at 1s (0.8% slop), while a 100ms budget
   * samples at 100ms and fires on time.
   */
  const nextDelay = (): number => {
    const remainingActive = Math.max(0, baseTimeoutMs - activeMs);
    const remainingSuspended = Math.max(0, extensionMs - suspendedMs);
    // Bound by BOTH budgets, always — including `remainingActive` while an
    // elicitation is pending. That looks redundant (the active clock is paused)
    // but it is what bounds how late we notice the elicitation *ending*: a
    // 100ms budget that samples every 1s during a 5-minute wait would overshoot
    // by up to 1s the moment the user answers. Sampling at 100ms throughout
    // costs nothing measurable and keeps the budget honest on both sides of the
    // transition.
    return Math.max(
      1,
      Math.min(intervalMs, remainingActive, remainingSuspended)
    );
  };

  const tick = () => {
    const now = Date.now();
    const elapsed = Math.max(0, now - lastSampleAt);
    lastSampleAt = now;

    if (hasPending()) {
      suspendedMs += elapsed;
      if (suspendedMs >= extensionMs) {
        abortWith(
          createElicitationTimeoutError(
            `Request timed out: server "${serverId}" spent ${suspendedMs}ms waiting on elicitation responses, exceeding the ${extensionMs}ms elicitation budget for this tool call.`,
            { serverId, timeout: extensionMs, reason: "elicitation-budget" }
          )
        );
        return;
      }
    } else {
      activeMs += elapsed;
      if (activeMs >= baseTimeoutMs) {
        abortWith(
          createElicitationTimeoutError(
            `Request timed out after ${activeMs}ms of server time (${baseTimeoutMs}ms budget, excluding time suspended on elicitation).`,
            { serverId, timeout: baseTimeoutMs, reason: "server-timeout" }
          )
        );
        return;
      }
    }

    if (disposed) return;
    schedule();
  };

  function schedule() {
    timer = setTimeout(tick, nextDelay());
    // Never hold the event loop open on this watchdog.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  schedule();
  const composed = composeAbortSignals(
    callerSignal ? [callerSignal, watchdog.signal] : [watchdog.signal]
  );

  return {
    signal: composed.signal,
    timeoutMs: baseTimeoutMs + extensionMs,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      composed.dispose();
    },
  };
}
