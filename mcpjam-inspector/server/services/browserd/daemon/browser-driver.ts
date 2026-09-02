/**
 * The seam between the daemon's control plane (queue + HTTP) and the real
 * browser. The control plane owns ordering, de-duplication, auth, and boot
 * identity; the driver owns the Chromium/CDP work. Keeping it an interface lets
 * every layer above be unit-tested with a fake driver — the way PR (a)'s queue
 * injects a `CommandExecutor` — while the real Playwright/CDP driver (with its
 * launch flags, settle logic, and profile-lock handling) lands with the boot
 * recipe in PR (c), where it can actually drive a browser.
 */
import {
  BrowserCommand,
  BrowserCommandResult,
  ObservationStateToken,
} from "../protocol";
import type { CommandExecutor } from "./command-queue";

export interface DriverHealth {
  ok: boolean;
  /** Free-text reason when `ok` is false (e.g. "chromium exited"). */
  detail?: string;
}

export interface BrowserDriver {
  /**
   * Execute one command against the real browser and return its result. This is
   * exactly the `CommandExecutor` the queue drives; the queue owns idempotency,
   * so the driver may assume it is asked to run a given commandId at most once.
   */
  execute(command: BrowserCommand): Promise<BrowserCommandResult>;
  /**
   * The current rendered-state token for a tab (L3), or undefined if the tab is
   * unknown. Read WITHOUT mutating the page, so the staleness guard can compare
   * it against an act's `expectedState` before deciding whether to execute.
   */
  currentStateToken(
    tabId: string | undefined,
  ): Promise<ObservationStateToken | undefined>;
  /** Liveness of the underlying browser process, for `GET /healthz`. */
  health(): Promise<DriverHealth>;
  /** Tear the browser down. Called on daemon shutdown. */
  close(): Promise<void>;
}

/** Structural equality of two state tokens (L3). */
export function stateTokensMatch(
  a: ObservationStateToken,
  b: ObservationStateToken,
): boolean {
  return (
    a.tabId === b.tabId &&
    a.navCounter === b.navCounter &&
    a.urlHash === b.urlHash &&
    a.domHash === b.domHash
  );
}

/**
 * Wrap a driver's `execute` with the L3 staleness check, producing the
 * `CommandExecutor` the queue runs. For an `act` that carries an
 * `expectedState`, the guard reads the tab's CURRENT token first; if the page
 * has navigated or mutated structurally since the observation the act was
 * decided from, it REFUSES the act (returns `staleObservation`) instead of
 * clicking the wrong place, and hands back the fresh token so the caller
 * re-observes. Everything else — acts without an expected token, and every
 * non-act command — passes straight through.
 *
 * The check lives here, above the driver, so it is pure and testable with a
 * fake driver: the real driver never has to special-case staleness.
 */
export function guardStaleness(driver: BrowserDriver): CommandExecutor {
  return async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    const { action } = command;
    if (action.kind !== "act" || action.expectedState === undefined) {
      return driver.execute(command);
    }
    const current = await driver.currentStateToken(command.tabId);
    if (current !== undefined && !stateTokensMatch(current, action.expectedState)) {
      // The page moved under the model. Do NOT act; return the fresh state so
      // it can re-decide from what is actually on screen now.
      return {
        ok: false,
        staleObservation: true,
        error: "stale_observation",
        stateToken: current,
      };
    }
    return driver.execute(command);
  };
}
