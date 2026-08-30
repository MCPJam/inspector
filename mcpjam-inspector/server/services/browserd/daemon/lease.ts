/**
 * The human-handoff lease (L6/W4).
 *
 * A person sometimes has to take the browser: an SSO login, a CAPTCHA, a
 * card number. While they hold it, TWO things must be true, and both are
 * enforced here at the daemon rather than filtered downstream — a filter that
 * runs after the frame was captured has already put it somewhere:
 *
 *   1. no model-driven command runs, and
 *   2. nothing observes — no screenshot, no DOM, no console. A person typing
 *      a password into this browser must not have it land in a trace because
 *      an agent happened to poll while they typed.
 *
 * A lease that runs out PARKS. It never auto-resumes, because the human might
 * be mid-flow and the model resuming underneath them is exactly the surprise
 * this feature exists to prevent — and because "the timer expired" is not
 * evidence that the private moment is over. Only an explicit `resume` hands
 * control back.
 *
 * Pure state, no I/O: the HTTP layer maps `held`/`parked` to 423 and the
 * driver reads `resumedDirty` to force a fresh observation (L6's loud resume).
 */

export type LeaseState =
  /** Nobody holds it; commands run normally. */
  | { state: "free" }
  /** A person holds it, until `expiresAt`. */
  | { state: "held"; holder: string; expiresAt: number }
  /**
   * A held lease ran out of time. Commands stay blocked: the person may still
   * be mid-flow, and only an explicit resume can know otherwise.
   */
  | { state: "parked"; holder: string };

export interface LeaseOptions {
  /** Injectable clock, so expiry is testable without waiting. */
  now?: () => number;
  /** Default TTL when an acquire does not name one. */
  defaultTtlMs?: number;
  /** Ceiling on any requested TTL. */
  maxTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;

export class HandoffLease {
  private current: LeaseState = { state: "free" };
  /**
   * Set by `resume`, consumed once by the next observation. This is what makes
   * the resume LOUD: the model is told the state may have changed — including
   * logins and cookies — instead of continuing against a page it last saw
   * before a human touched it.
   */
  private resumedDirty = false;
  /**
   * When the CURRENT hold began — the start of the window whose captured
   * console must not outlive the handoff. Set on the free→held transition
   * only, so a heartbeat or a re-acquire out of `parked` does not shorten the
   * window and leave the earliest (most sensitive) entries readable.
   */
  private heldSince: number | undefined;
  /** `heldSince` of the hold that just ended, consumed alongside the flag. */
  private resumedHeldSince: number | undefined;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;

  constructor(options: LeaseOptions = {}) {
    this.now = options.now ?? Date.now;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxTtlMs = options.maxTtlMs ?? MAX_TTL_MS;
  }

  /**
   * The lease as of NOW. Expiry is evaluated lazily on every read — there is
   * no timer to miss, and a state read after a restart or a long pause is
   * still correct.
   */
  state(): LeaseState {
    if (this.current.state === "held" && this.now() >= this.current.expiresAt) {
      // PARK, never free: see the module docstring.
      this.current = { state: "parked", holder: this.current.holder };
    }
    return this.current;
  }

  /** True while any model-driven command (and every observation) is blocked. */
  isBlocking(): boolean {
    return this.state().state !== "free";
  }

  acquire(holder: string, ttlMs?: number): LeaseState {
    const state = this.state();
    if (state.state !== "free" && state.holder !== holder) {
      // Someone else is in the middle of something private. Handing the
      // browser to a second person mid-flow is worse than refusing.
      return state;
    }
    const ttl = Math.min(
      Math.max(1_000, ttlMs ?? this.defaultTtlMs),
      this.maxTtlMs,
    );
    // Only a hold that starts from `free` opens a new window.
    if (state.state === "free") this.heldSince = this.now();
    this.current = {
      state: "held",
      holder,
      expiresAt: this.now() + ttl,
    };
    return this.current;
  }

  /** Extend the holder's own lease; a no-op for anyone else. */
  heartbeat(holder: string, ttlMs?: number): LeaseState {
    const state = this.state();
    if (state.state !== "held" || state.holder !== holder) return state;
    return this.acquire(holder, ttlMs);
  }

  /**
   * Hand control back. Only the holder may — including from `parked`, which
   * is the ordinary "I'm done, carry on" path after a lease ran out while a
   * person was still working.
   */
  resume(holder: string): LeaseState {
    const state = this.state();
    if (state.state === "free") return state;
    if (state.holder !== holder) return state;
    this.current = { state: "free" };
    this.resumedDirty = true;
    this.resumedHeldSince = this.heldSince;
    this.heldSince = undefined;
    return this.current;
  }

  /** `resume` under its user-facing name; identical semantics. */
  release(holder: string): LeaseState {
    return this.resume(holder);
  }

  /**
   * Whether the next observation must carry the loud-resume note, consumed
   * once. The daemon asks this AFTER a command runs, so the note rides the
   * first result a human handoff could have invalidated.
   */
  consumeResumedDirty(): boolean {
    const dirty = this.resumedDirty;
    this.resumedDirty = false;
    return dirty;
  }

  /**
   * The start of the hold that just ended, consumed once.
   *
   * The daemon uses it to DISCARD console captured while a person held the
   * browser. The 423 gate stops an agent reading during the handoff, but the
   * console ring fills eagerly from a page listener that knows nothing about
   * leases — so without this, an auth token or a form value the page logged
   * during someone's login is simply readable the moment they hand back. That
   * would make the guarantee "you must wait to read it", not "it is private".
   */
  consumeResumedHeldSince(): number | undefined {
    const since = this.resumedHeldSince;
    this.resumedHeldSince = undefined;
    return since;
  }
}

/**
 * The note a post-handoff observation carries. Deliberately explicit about
 * AUTH and COOKIES: the common handoff is a login, so "something may have
 * changed" would understate exactly the change that just happened.
 */
export const RESUMED_AFTER_HANDOFF_NOTE =
  "A person took control of this browser and has handed it back. The page " +
  "state may have changed — including logins, cookies and navigation. This " +
  "observation is fresh; do not rely on anything you saw before the handoff.";
