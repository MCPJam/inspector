/**
 * L2 — settling a page before capture, instead of exposing a `wait` verb.
 *
 * Models reflexively insert click → sleep(5s) → screenshot, and every sleep is a
 * wasted turn and a wrong guess about duration. browserd removes the need: after
 * a navigation or an act, it settles the page HERE — nav commit → a brief
 * network-quiet window → one animation frame — and only then captures. When a
 * page genuinely will not settle within the budget, the driver returns the frame
 * anyway with `settled: false` (see `BrowserCommandResult`), and the model
 * re-observes only when told the state is unsettled — it never asks browserd to
 * wait.
 *
 * This module is the pure POLICY: the sequence and the timeout budget. The three
 * waits are injected so the driver wires them to Playwright (`waitForLoadState`,
 * a network-idle watcher, an `evaluate` of `requestAnimationFrame`) while the
 * decision logic stays unit-testable without a browser.
 */

export interface SettleSteps {
  /** Resolves when the navigation has committed. */
  waitForCommit(signal: AbortSignal): Promise<void>;
  /** Resolves after a short window with no in-flight requests. */
  waitForNetworkQuiet(signal: AbortSignal): Promise<void>;
  /** Resolves after one rendered frame, so layout reflects the settled DOM. */
  waitForAnimationFrame(signal: AbortSignal): Promise<void>;
}

export interface SettleOptions {
  /** Total budget for the whole sequence; past it, return `settled: false`. */
  maxWaitMs: number;
}

export const DEFAULT_SETTLE_OPTIONS: SettleOptions = { maxWaitMs: 10_000 };

/**
 * Run the settle sequence, bounded by `maxWaitMs`. Returns `{ settled: true }`
 * when the page came to rest within budget, `{ settled: false }` when it did not
 * (the caller captures and returns the frame regardless — never a wait verb). A
 * step that fails for a reason OTHER than the timeout propagates: that is a real
 * fault (e.g. the page crashed), not mere slowness, and must not masquerade as
 * an unsettled frame.
 */
export async function settlePage(
  steps: SettleSteps,
  options: SettleOptions = DEFAULT_SETTLE_OPTIONS,
): Promise<{ settled: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.maxWaitMs);
  try {
    await steps.waitForCommit(controller.signal);
    await steps.waitForNetworkQuiet(controller.signal);
    await steps.waitForAnimationFrame(controller.signal);
    return { settled: true };
  } catch (err) {
    if (timedOut) return { settled: false };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
