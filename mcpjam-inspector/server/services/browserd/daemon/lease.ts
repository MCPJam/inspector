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
  | { state: "held"; holder: string; holderKind: LeaseHolderKind; expiresAt: number }
  /**
   * A held lease ran out of time. Commands stay blocked: the person may still
   * be mid-flow, and only an explicit resume can know otherwise.
   */
  | { state: "parked"; holder: string; holderKind: LeaseHolderKind };

/**
 * WHAT is holding the browser, which the resume note names.
 *
 * `human` is someone driving the pane. `script` is a program the user attached
 * over the CDP endpoint — it blocks the agent exactly as a person does (the
 * point is that two drivers never share one page), but the model should be
 * told which, because "a script logged in and left" and "a person logged in
 * and left" lead to different next moves.
 */
export type LeaseHolderKind = "human" | "script";

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
  /** The kind of the current (or just-ended) hold; see `LeaseHolderKind`. */
  private holderKind: LeaseHolderKind = "human";
  /** The kind of the hold the pending resume note describes. */
  private resumedHolderKind: LeaseHolderKind | undefined;
  /**
   * Start of the EARLIEST hold that has ended without its console being purged
   * yet, consumed alongside the flag.
   *
   * Earliest, not latest, because the purge is consumed lazily — by the next
   * command — and nothing says a second handoff cannot happen first. Two
   * complete cycles back to back (sign in, hand back, solve a CAPTCHA, hand
   * back) with no command in between would otherwise overwrite this with the
   * SECOND hold's start, and the first hold's console — the sign-in, the most
   * sensitive window of the two — would survive the purge and be readable.
   */
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
      this.current = {
        state: "parked",
        holder: this.current.holder,
        holderKind: this.current.holderKind,
      };
    }
    return this.current;
  }

  /** True while any model-driven command (and every observation) is blocked. */
  isBlocking(): boolean {
    return this.state().state !== "free";
  }

  acquire(
    holder: string,
    ttlMs?: number,
    kind: LeaseHolderKind = "human",
  ): LeaseState {
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
    if (state.state === "free") {
      this.heldSince = this.now();
      this.holderKind = kind;
    }
    this.current = {
      state: "held",
      holder,
      holderKind: this.holderKind,
      expiresAt: this.now() + ttl,
    };
    return this.current;
  }

  /** Extend the holder's own lease; a no-op for anyone else. */
  heartbeat(holder: string, ttlMs?: number): LeaseState {
    const state = this.state();
    if (state.state !== "held" || state.holder !== holder) return state;
    // The kind rides the existing hold: a heartbeat re-acquires, and passing
    // the default would silently relabel a script's lease as a person's.
    return this.acquire(holder, ttlMs, state.holderKind);
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
    // Widen to the earliest un-consumed hold, never replace it: a pending purge
    // means no command has run since that hold ended, so its console is still
    // in the ring waiting to be dropped. See `resumedHeldSince`.
    if (this.resumedHeldSince === undefined) {
      this.resumedHeldSince = this.heldSince;
      this.resumedHolderKind = this.holderKind;
    }
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

  /**
   * What held the browser across the handoff the next observation describes.
   * Read (not consumed) alongside `consumeResumedDirty`, which owns the
   * once-only semantics — two independent consume flags would let the note and
   * its subject come apart.
   */
  resumedFromKind(): LeaseHolderKind {
    return this.resumedHolderKind ?? this.holderKind;
  }
}

/**
 * Why the lease refuses a command, or undefined when it does not.
 *
 * Asked TWICE on two different sides of the queue — by the request handler
 * before a command is admitted, and by `guardLease` when the command reaches
 * the front of its tab's FIFO — because a command admitted a moment before
 * someone took the browser would otherwise run under their hands. One
 * predicate, two evaluation points; a second copy of this reasoning is a
 * second place for a bypass to appear.
 *
 * The command is typed structurally rather than imported, so this module keeps
 * its "pure state, no dependencies" property.
 */
export function leaseRefusalFor(
  lease: LeaseState,
  command: { source: string; holder?: string },
): LeaseRefusal | undefined {
  if (command.source !== "manual") {
    if (lease.state === "free") return undefined;
    return lease.state === "held" ? "lease_held" : "lease_parked";
  }
  // A person's own command. It has to belong to a lease: with nobody holding
  // it the agent may be mid-turn, and two drivers on one page is exactly what
  // the lease exists to prevent. And it has to belong to THIS one — an
  // unauthenticated `manual` would let anything that reaches the daemon drive
  // and observe a browser someone is signing into.
  if (lease.state === "free") return "lease_required";
  if (!command.holder || command.holder !== lease.holder) {
    return "lease_held_by_other";
  }
  return undefined;
}

export type LeaseRefusal =
  | "lease_held"
  | "lease_parked"
  | "lease_required"
  | "lease_held_by_other";

/**
 * The note a post-handoff observation carries. Deliberately explicit about
 * AUTH and COOKIES: the common handoff is a login, so "something may have
 * changed" would understate exactly the change that just happened.
 */
export const RESUMED_AFTER_HANDOFF_NOTE =
  "A person took control of this browser and has handed it back. The page " +
  "state may have changed — including logins, cookies and navigation. This " +
  "observation is fresh; do not rely on anything you saw before the handoff.";

/** The same note for a script that was driving the page over CDP. */
export const RESUMED_AFTER_SCRIPT_NOTE =
  "A script took control of this browser over its debugging endpoint and has " +
  "released it. The page state may have changed — including logins, cookies " +
  "and navigation. This observation is fresh; do not rely on anything you saw " +
  "before it ran.";

/** The note for a handoff of this kind. */
export function handoffNoteFor(kind: LeaseHolderKind): string {
  return kind === "script"
    ? RESUMED_AFTER_SCRIPT_NOTE
    : RESUMED_AFTER_HANDOFF_NOTE;
}
