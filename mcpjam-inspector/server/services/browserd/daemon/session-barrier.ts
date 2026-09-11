/**
 * The one place a session may change SHAPE, and the rule that it may only do so
 * between actions.
 *
 * Resizing is not like the other things that happen to a browser. Every other
 * command belongs to a tab and the per-tab FIFOs serialize them; a resize
 * belongs to the SESSION — it changes the display, the window, and every tab's
 * viewport at once — so a per-tab queue cannot order it against anything. Two
 * bugs follow directly from that, and both are the kind that produce a wrong
 * answer rather than an error:
 *
 *   1. A RESIZE MID-ACTION. The driver resolves a selector to a box, the
 *      layout reflows underneath it, and the click that follows lands on
 *      whatever moved into that rectangle. The daemon's staleness guard cannot
 *      catch it: the guard runs before the act, and the reflow happens after.
 *   2. A RESIZE MID-DRAG. A page tracking the pointer through a reflow gets a
 *      move sequence that jumps across a re-laid-out document, which for a
 *      canvas or a slider is not a jump but a value nobody chose.
 *
 * So: work and resizes are mutually exclusive, resizes wait for quiet, and the
 * measurements that ask for them are COALESCED rather than queued. That last
 * one is not an optimisation. A person dragging the panel divider produces a
 * measurement per animation frame — sixty a second, each a full display + kiosk
 * + viewport + encoder transition on a two-core box — and applying them in
 * order would still be applying them a minute after they stopped dragging.
 * Only the last size was ever wanted.
 *
 * Timers are injected so the debounce is testable without waiting.
 */

import type { ViewportSize } from "../../../../shared/browser-viewport";

export interface SessionBarrierOptions {
  /**
   * How long a measurement waits for a quieter one to replace it.
   *
   * Long enough to swallow a drag, short enough that a person who let go does
   * not watch a stale layout. 150ms is roughly the point where a resize stops
   * reading as "the app is responding" and starts reading as "the app is
   * lagging", and a drag produces measurements far faster than that.
   */
  debounceMs?: number;
  /**
   * Ceiling on timer polling while waiting for in-flight work to finish.
   *
   * A resize that waited forever would be a browser stuck at the wrong size
   * behind one hung command — and the hung command's own timeout is minutes.
   * On expiry we stop polling and wait for work/drag completion. A timeout
   * is not proof that input stopped; it must never break mutual exclusion.
   */
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_WAIT_MS = 5_000;

/** What a resize actually does. Returns the size that was applied. */
export type ResizeApplier = (size: ViewportSize) => Promise<void>;

export class SessionBarrier {
  private inFlight = 0;
  /**
   * Is a person's pointer down on the page right now?
   *
   * Separate from `inFlight` because it is not work the barrier can wait for:
   * a drag has no promise to await, it ends when somebody lifts a finger, and
   * a resize during one corrupts a value rather than merely disturbing it.
   */
  private dragging = false;
  /**
   * The transition in progress, or null.
   *
   * A PROMISE rather than a boolean plus a waiter list, because the two lists
   * a naive version needs — "waiting for this resize to end" and "waiting for
   * my measurement to land" — are refilled at different moments, and a `run()`
   * that queued itself on the second one waits for the NEXT resize instead of
   * the current one. That is a deadlock when there is no next resize, which is
   * the ordinary case: somebody stops dragging.
   */
  private resizing: Promise<void> | null = null;
  /** The newest measurement, waiting for the debounce. */
  private pending: ViewportSize | null = null;
  private debounceHandle: unknown;
  private pendingSince = 0;
  /**
   * Everyone whose `request` has not landed yet.
   *
   * Resolved together when the resize that supersedes them all completes: they
   * are waiting for the same transition, and a caller that got its own promise
   * would resolve at a different moment from the others for no reason.
   */
  private requestWaiters: Array<() => void> = [];
  /**
   * Armed when a resize is deferred, so the ceiling can enforce itself.
   *
   * Without it `maxWaitMs` was only ever CHECKED, never awaited: `maybeResize`
   * runs on the debounce firing, on work finishing and on a drag ending, and a
   * command that hangs while nobody is dragging produces none of the three. The
   * pending resize then waited on an event that was never coming, which is the
   * opposite of what a ceiling is for — the one case it exists for is the one
   * where the session never goes quiet.
   */
  private expiryHandle: unknown;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly apply: ResizeApplier,
    options: SessionBarrierOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>);
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /**
   * Run one piece of page work, held off while a resize is transitioning.
   *
   * Wrapping rather than a bare `enter`/`leave` pair, because the thing being
   * guarded can throw and a `leave` that a rejection skipped would wedge the
   * barrier closed for the life of the session — every subsequent resize
   * waiting out `maxWaitMs` for work that finished long ago.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    // A resize already transitioning is waited out, not raced. This is the
    // "never mid-action" rule seen from the other side: an act that started
    // while the display was between geometries would resolve a box in one and
    // click in the other. A LOOP rather than one await, because the burst that
    // produced this transition may start another the moment it finishes.
    while (this.resizing) await this.resizing;
    this.inFlight += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.maybeResize();
    }
  }

  /** A pointer went down on the page; hold resizes until it comes up. */
  beginDrag(): void {
    this.dragging = true;
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.maybeResize();
  }

  /**
   * Ask for a size. Coalesces with anything already waiting.
   *
   * Returns a promise that settles when a resize carrying AT LEAST this
   * measurement's intent has been applied — which for a coalesced burst is one
   * resize for all of them. It deliberately does not promise that the applied
   * size equals the requested one: a later measurement supersedes an earlier
   * one, and the earlier caller wanted "the panel is now the right size", not
   * "my particular number was used".
   */
  request(size: ViewportSize): Promise<void> {
    this.pending = size;
    if (this.pendingSince === 0) this.pendingSince = this.now();
    const settled = new Promise<void>((resolve) => {
      this.requestWaiters.push(resolve);
    });
    this.clearTimer(this.debounceHandle);
    this.debounceHandle = this.setTimer(() => {
      this.debounceHandle = undefined;
      this.maybeResize();
    }, this.debounceMs);
    return settled;
  }

  /** Is a resize waiting or running? For the pane's "settling" affordance. */
  get busy(): boolean {
    return this.resizing !== null || this.pending !== null;
  }

  /**
   * Wake up in `ms` and reconsider, replacing any timer already waiting.
   *
   * Replacing rather than stacking: the budget is a property of the pending
   * measurement, not of the calls that noticed it, and several deferrals in a
   * row must not each add a wake-up.
   */
  private armExpiry(ms: number): void {
    this.clearTimer(this.expiryHandle);
    this.expiryHandle = this.setTimer(() => {
      this.expiryHandle = undefined;
      this.maybeResize();
    }, Math.max(0, ms));
  }

  /**
   * Run the pending resize only when the session is quiet.
   *
   * Called from three places (the debounce firing, work finishing, a drag
   * ending) because those are the three ways the answer can change, and a
   * version that only checked on the timer would leave a resize parked behind
   * a command that outlived its debounce.
   */
  private maybeResize(): void {
    if (this.resizing || this.pending === null) return;
    // The debounce has not fired yet: a newer measurement may still be coming.
    if (this.debounceHandle !== undefined) return;
    const waited = this.now() - this.pendingSince;
    const expired = waited >= this.maxWaitMs;
    if (this.inFlight > 0 || this.dragging) {
      // Come back when the budget runs out, whether or not anything else
      // happens between now and then. @see expiryHandle
      if (!expired) this.armExpiry(this.maxWaitMs - waited);
      return;
    }
    this.clearTimer(this.expiryHandle);
    this.expiryHandle = undefined;
    const size = this.pending;
    this.pending = null;
    this.pendingSince = 0;
    const waiters = this.requestWaiters;
    this.requestWaiters = [];
    this.resizing = this.apply(size)
      .catch(() => {
        // The applier owns its own failure reporting — it is the thing that
        // knows whether the display, the browser or the encoder refused, and
        // it is the thing that restores the last confirmed geometry. Swallowed
        // here so one failed resize cannot leave the barrier latched shut.
      })
      .then(() => {
        this.resizing = null;
        for (const resolve of waiters) resolve();
        // A measurement that arrived DURING the transition is still pending;
        // this is what makes a burst that spans a resize converge rather than
        // stopping one size short.
        this.maybeResize();
      });
  }
}
