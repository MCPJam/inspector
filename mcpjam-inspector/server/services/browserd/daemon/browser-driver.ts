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
  WebMcpToolsRevision,
  formatBrowserdError,
  wantsFor,
} from "../protocol";
import type { CommandExecutor } from "./command-queue";
import type { TabViewport } from "./viewport";
import {
  leaseRefusalFor,
  type HandoffLease,
  type LeaseRefusal,
} from "./lease";

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
  /**
   * The live picture of a tab, for a PERSON rather than the model.
   *
   * Optional because a driver that cannot open a CDP session (a unit fake, a
   * future engine that streams some other way) is still a perfectly good
   * driver — the model's path never needs this. Resolves `null` when this tab
   * cannot be watched.
   */
  viewport?(tabId?: string): Promise<TabViewport | null>;
  /**
   * What is open and which one is on screen — for the HUMAN pane.
   *
   * Optional, like `viewport`: a driver with no concept of tabs is still a
   * perfectly good driver, and the model's path never reads this. It exists
   * because the hosted video stream grabs the X display, so a model
   * `activate_tab` changes what a watching person sees; without this the pane
   * could not say so, and the picture would simply become a different page.
   */
  tabsSnapshot?(): { active?: string; list: Array<{ id: string; url: string }> };
  /**
   * A tab's page-tool set as `{revision, hash, count}`, read from the driver's
   * own cache.
   *
   * Optional, like `viewport` and `tabsSnapshot`: a driver with no WebMCP is
   * still a perfectly good driver, and every caller treats `undefined` as
   * "this engine cannot tell you" rather than as "no tools".
   *
   * TOUCHES NO PAGE, which is the property that lets it ride a heartbeat and
   * be asked before every model step.
   */
  webmcpToolsSnapshot?(tabId?: string): WebMcpToolsRevision | undefined;
  /**
   * Hand the driver a way to ask the queue whether a command is admitted but
   * not yet dequeued, so a `webmcp_cancel` for a QUEUED invoke can be latched
   * and honoured when that invoke's turn comes. Optional: a driver with no
   * cancellation path has nothing to latch.
   */
  attachCommandProbe?(probe: (commandId: string) => boolean): void;
  /**
   * Look at a tab WITHOUT acting on it, for a refusal that owes the caller a
   * fresh page (L3's `stale_observation`).
   *
   * Optional for the same reason `viewport` is: a driver that cannot observe
   * on demand — a unit fake, an engine with no such read — is still a
   * perfectly good driver, and the guard degrades to the bare token it has
   * always returned rather than failing.
   */
  observeForRefusal?(
    command: BrowserCommand,
    wants: { a11y: boolean; screenshot: boolean },
  ): Promise<BrowserCommandResult>;
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
 * clicking the wrong place, and hands back the fresh token — and, when the
 * driver can take one, the fresh OBSERVATION — so the caller re-decides
 * without spending another call looking. Everything else — acts without an
 * expected token, and every non-act command — passes straight through.
 *
 * The check lives here, above the driver, so it is pure and testable with a
 * fake driver: the real driver never has to special-case staleness.
 */
export function guardStaleness(
  driver: BrowserDriver,
  lease?: Pick<HandoffLease, "state">,
): CommandExecutor {
  return async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    const { action } = command;
    if (action.kind !== "act" || action.expectedState === undefined) {
      return driver.execute(command);
    }
    const current = await driver.currentStateToken(command.tabId);
    // Re-asked AFTER the await. Reading the token touches the page (its URL
    // and DOM signal), and `guardLease` upstream can only vouch for the moment
    // before that read began — a handoff landing during it would otherwise let
    // the answer, and the act behind it, run under the person's hands.
    const refusal = lease && leaseRefusalFor(lease.state(), command);
    if (refusal) return leaseBlockedResult(refusal);
    if (current !== undefined && !stateTokensMatch(current, action.expectedState)) {
      // The page moved under the model. Do NOT act; return the fresh state so
      // it can re-decide from what is actually on screen now.
      //
      // AND THE PAGE ITSELF, when the driver can produce one. The refusal used
      // to carry the token alone while telling the model to re-read the page —
      // so the recovery cost exactly the round trip the token exists to save.
      // The fresh look is taken in the shape the act asked for, so a model
      // that wanted a tree gets a tree back rather than a screenshot it did
      // not ask for.
      // BEST EFFORT, and a rejection must not cost the refusal. The recovery
      // read touches the page (a CDP attach, an AX walk, a DOM evaluate) and
      // the very thing that made this act stale — a navigation, a closing tab
      // — is what makes those reads throw. Letting that escape would turn
      // "the page moved, here it is" into a generic command failure, which is
      // strictly worse than the bare token refusal this had before.
      const fresh = await Promise.resolve(
        driver.observeForRefusal?.(command, wantsFor(action.observe)),
      ).catch(() => undefined);
      // A person took the browser DURING the recovery read: that refusal wins,
      // by the same rule as the check above — nothing was run and nothing was
      // observed, and saying "stale" here would send the model to re-read a
      // page it is not allowed to see.
      if (fresh?.leaseBlocked) return fresh;
      // THE TOKEN AND THE PICTURE TRAVEL TOGETHER OR NOT AT ALL.
      //
      // A recovery read that could not bind its capture comes back with no
      // `stateToken` — on purpose, because the page moved under the capture
      // and no token honestly describes what it shows. Falling back to
      // `current` while still forwarding that output would hand the model two
      // different page states in one answer: a picture of B pinned to A.
      //
      // And A is the LIVE token, freshly read. So the next act, decided from
      // that picture, pins to A, matches, and sails through this very guard —
      // the stale targeting L3 exists to refuse, admitted by the refusal
      // meant to prevent it. Worse than the bare token this used to send,
      // because the model has no way to tell the picture is not the page.
      //
      // Unbound, the capture is dropped and the refusal degrades to exactly
      // what it was before the fresh look was added: a token, and "look
      // again". Which is the honest answer when nobody can say what the page
      // looks like.
      const bound = fresh?.stateToken !== undefined;
      return {
        ok: false,
        staleObservation: true,
        error: "stale_observation",
        stateToken: bound ? fresh!.stateToken : current,
        ...(bound && fresh!.output !== undefined
          ? { output: fresh!.output }
          : {}),
      };
    }
    return driver.execute(command);
  };
}

/**
 * The one answer both lease guards give, so a caller can match on the code
 * without caring which gate refused it.
 */
function leaseBlockedResult(refusal: LeaseRefusal): BrowserCommandResult {
  return {
    ok: false,
    leaseBlocked: true,
    error: formatBrowserdError(
      refusal,
      "a person took control of this browser before this action ran; nothing was run and nothing was observed",
    ),
  };
}

/**
 * Wrap an executor with the lease check, re-asked AT DEQUEUE.
 *
 * The handler refuses commands that ARRIVE while a person holds the browser.
 * That is not the whole story: the per-tab FIFO can hold several commands, and
 * one admitted a moment before someone clicked "Take control" would otherwise
 * run — and capture — under their hands. The queue is deliberately not drained
 * or cancelled (a cancelled command would have to be re-issued blind, and its
 * commandId is already spent); instead each one re-asks the same question when
 * its turn comes, and the ones that lose answer `leaseBlocked` without ever
 * reaching the driver.
 *
 * Composed OUTSIDE `guardStaleness` so the lease is checked before the
 * staleness read, which is itself an observation of the page — and
 * `guardStaleness` is handed the same lease so it can re-ask after that read,
 * which is the only window this gate cannot cover.
 */
export function guardLease(
  lease: Pick<HandoffLease, "state">,
  executor: CommandExecutor,
): CommandExecutor {
  return async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    const refusal = leaseRefusalFor(lease.state(), command);
    if (refusal) return leaseBlockedResult(refusal);
    return executor(command);
  };
}
