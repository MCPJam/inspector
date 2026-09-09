/**
 * Taking the browser by using it, once, without racing anybody.
 *
 * The old shape was a BUTTON: "Take control", then click. That is honest about
 * the lease and wrong about what people expect from a browser — Codex's has no
 * such button, and neither does any browser anybody has used. The new shape is
 * that a click, a keystroke, a scroll or a navigation takes the browser as a
 * side effect of being those things.
 *
 * Which turns one gesture into a small distributed problem, because acquiring
 * is a round trip and gestures do not wait for round trips. Three things go
 * wrong without a coordinator, and each is worse than the button was:
 *
 *   1. A BURST OF ACQUIRES. A person clicks into the page and immediately
 *      drags; a scroll is a dozen wheel events. Each would start its own
 *      acquire, and the server would see a dozen requests for a lease it has
 *      already granted.
 *   2. THE INITIATING GESTURE LOST, or delivered twice. The click that took
 *      the browser is the one the person meant; dropping it makes them click
 *      again, and delivering it from two paths clicks twice.
 *   3. THE GESTURE DELIVERED INTO A DIFFERENT PAGE. The acquire takes a
 *      moment, the page finishes loading in it, and a coordinate decided from
 *      the old screenshot lands on whatever moved into that rectangle.
 *
 * So: one acquire at a time, the initiating gesture held and delivered exactly
 * once, and only if the page it was aimed at is still there. Everything that
 * arrives DURING an acquire is dropped rather than queued — a queue would
 * replay half a drag into a page that has since scrolled, and the person's
 * hand is still on the mouse.
 */

import {
  anchorStillValid,
  type BrowserPaneHolder,
  type InteractionAnchor,
} from "../../../../shared/browser-pane-command";

/** What the coordinator was asked to do, once the lease is ours. */
export type PendingInteraction<T> = {
  payload: T;
  /** Where it was aimed, captured before the acquire. May be absent. */
  anchor?: InteractionAnchor;
};

export type TakeoverResult<T> =
  /** Deliver this, now. */
  | { status: "deliver"; payload: T }
  /** The lease is ours but the page moved; the pane shows a retry notice. */
  | { status: "dropped"; reason: "page_changed" }
  /** Somebody else is driving. Nothing happened. */
  | { status: "refused"; holder?: BrowserPaneHolder }
  /** An acquire was already running; this gesture is not the initiating one. */
  | { status: "coalesced" }
  /** The acquire itself failed — offline, a 500, a closed session. */
  | { status: "failed"; detail?: string };

export interface TakeoverDeps<T = unknown> {
  /**
   * The payload type this coordinator carries, tied to the class's own.
   *
   * Declared rather than inferred so `TakeoverDeps` and `TakeoverCoordinator`
   * cannot drift into two different `T`s at one call site — the deps object is
   * usually written inline, where TypeScript would otherwise be free to infer
   * `unknown` for it and accept a mismatched `gesture` payload.
   */
  readonly __payload?: T;
  /** Do we already hold the browser? Read at call time, never cached. */
  isHolding: () => boolean;
  /** Take the lease. Resolves with what happened. */
  acquire: () => Promise<AcquireOutcome>;
  /**
   * Read the page the gesture was aimed at, as it is NOW.
   *
   * Absent, or resolving null, means the coordinator cannot check — and a
   * gesture with an anchor it cannot verify is dropped. "We could not check"
   * is not evidence that nothing moved.
   */
  readAnchor?: (tabId: string) => Promise<InteractionAnchor | null>;
}

/** What `acquire` resolves with. Named so the deps type reads without T. */
export type AcquireOutcome =
  | { ok: true }
  | { ok: false; holder?: BrowserPaneHolder; detail?: string };

export class TakeoverCoordinator<T> {
  /** The acquire in flight, so a burst joins it instead of starting more. */
  private inFlight: Promise<TakeoverResult<T>> | null = null;

  constructor(private readonly deps: TakeoverDeps<T>) {}

  /**
   * Run a gesture, taking the browser first if it is not already ours.
   *
   * Resolves with what the caller should do. The caller delivers; this decides
   * — the split matters because "deliver" means different things to a click
   * (an input batch) and to a navigation (a pane command), and a coordinator
   * that did the delivering would have to know both.
   */
  async gesture(
    interaction: PendingInteraction<T>,
  ): Promise<TakeoverResult<T>> {
    // Already ours: the overwhelmingly common case once somebody has started
    // driving, and it must cost nothing. No await, no round trip.
    if (this.deps.isHolding()) {
      return { status: "deliver", payload: interaction.payload };
    }
    if (this.inFlight) {
      // DROPPED, not queued. A queue would replay half a drag into a page that
      // has since scrolled, and the person's hand is still on the mouse — the
      // next event they generate is a better one than this.
      await this.inFlight;
      // Re-read rather than trusting the joined result: that result described
      // the INITIATING gesture, and this one is a different gesture that may
      // now simply proceed.
      return this.deps.isHolding()
        ? { status: "deliver", payload: interaction.payload }
        : { status: "coalesced" };
    }
    const run = this.acquireThen(interaction);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async acquireThen(
    interaction: PendingInteraction<T>,
  ): Promise<TakeoverResult<T>> {
    let outcome: AcquireOutcome;
    try {
      outcome = await this.deps.acquire();
    } catch (error) {
      return {
        status: "failed",
        ...(error instanceof Error ? { detail: error.message } : {}),
      };
    }
    if (!outcome.ok) {
      return {
        status: "refused",
        ...(outcome.holder ? { holder: outcome.holder } : {}),
      };
    }
    const anchor = interaction.anchor;
    // No anchor is not "unverified", it is "nothing to verify": a keystroke or
    // a scroll is aimed at whatever has focus, and a navigation is aimed at a
    // URL rather than at a pixel. Only a click carries one.
    if (!anchor) return { status: "deliver", payload: interaction.payload };
    if (!this.deps.readAnchor) return { status: "dropped", reason: "page_changed" };
    const fresh = await this.deps
      .readAnchor(anchor.tabId)
      .catch(() => null);
    return anchorStillValid(anchor, fresh)
      ? { status: "deliver", payload: interaction.payload }
      : { status: "dropped", reason: "page_changed" };
  }

  /** Is an acquire running right now? For the pane's transitional state. */
  get acquiring(): boolean {
    return this.inFlight !== null;
  }
}
