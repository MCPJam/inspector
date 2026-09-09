/**
 * "Somebody is still using this machine."
 *
 * The idle sweep hibernates a computer 30 minutes after its `lastActiveAt`,
 * and only bash commands and terminal I/O were bumping it. That is fine while
 * a computer is a shell, and wrong the moment it is also a browser: a person
 * can watch a hosted browser, drive it by hand through the panel, and invoke
 * page tools for an hour without the control plane seeing a single thing it
 * counts as activity — so the machine hibernates underneath them.
 *
 * Throttled because the touch is a control-plane write and the traffic that
 * triggers it is not: a tool poll every two seconds, an invocation per click.
 * Once a minute is far inside the 30-minute window and costs one write.
 *
 * Per-process, like the panel's original copy of this. A second replica
 * touching the same computer within the same minute sends a second write,
 * which is harmless — the failure this protects against is one replica writing
 * hundreds of times a minute, not two replicas writing twice.
 */

/** Don't touch a given key's activity more than once a minute. */
export const ACTIVITY_TOUCH_THROTTLE_MS = 60_000;

/**
 * How many computers this replica remembers having touched.
 *
 * The map is otherwise unbounded and never expires: a long-lived replica
 * serving thousands of members accumulates an entry per computer for the life
 * of the process. Each is small, and the failure is slow rather than sharp,
 * which is exactly the kind that gets found in a heap dump a year later.
 *
 * Evicting the OLDEST entry is safe by construction — the worst an eviction
 * can do is let one extra touch through, which is one control-plane write,
 * and the entry it drops is the one longest past its window anyway.
 */
export const MAX_TRACKED_COMPUTERS = 4_096;

/**
 * One throttle, instantiated per key space.
 *
 * Two clocks front two different control-plane writes — a computer's
 * `lastActiveAt` and a browser session's `lastCommandAt` — and they are keyed
 * by ids from different tables. They get separate maps rather than one shared
 * one so they cannot evict each other out of a single budget, and so both can
 * be in different phases for the same interaction (on a desktop box a single
 * input feeds both).
 */
function createTouchThrottle(windowMs: number, maxKeys: number) {
  const lastTouchAt = new Map<string, number>();
  return {
    shouldTouch(key: string, now: number = Date.now()): boolean {
      // `undefined` is kept distinct from a recorded 0: a key nobody has
      // touched must always be eligible for its first touch, and coalescing to
      // 0 makes that false whenever `now` is inside the window of the epoch.
      const previous = lastTouchAt.get(key);
      // `now - previous` is compared as an ABSOLUTE gap, so a clock that steps
      // backwards — an NTP correction, a suspended VM waking — cannot suppress
      // every touch until real time catches up with a stamp from the future.
      // That silence would be indefinite, and would end with somebody's
      // browser hibernating underneath them while they were using it.
      if (previous !== undefined && Math.abs(now - previous) < windowMs) {
        return false;
      }
      // Re-inserted rather than updated in place, so the key moves to the end
      // of the Map's insertion order and the eviction below takes a genuinely
      // old entry rather than a busy one that happened to be added first.
      lastTouchAt.delete(key);
      lastTouchAt.set(key, now);
      while (lastTouchAt.size > maxKeys) {
        const oldest = lastTouchAt.keys().next().value;
        if (oldest === undefined) break;
        lastTouchAt.delete(oldest);
      }
      return true;
    },
    reset(): void {
      lastTouchAt.clear();
    },
    size(): number {
      return lastTouchAt.size;
    },
  };
}

const computerThrottle = createTouchThrottle(
  ACTIVITY_TOUCH_THROTTLE_MS,
  MAX_TRACKED_COMPUTERS,
);
const sessionCommandThrottle = createTouchThrottle(
  ACTIVITY_TOUCH_THROTTLE_MS,
  MAX_TRACKED_COMPUTERS,
);

/**
 * May this computer's activity be touched now? Records the decision, so a
 * caller must only ask when it is actually about to touch.
 */
export function shouldTouchActivity(
  computerId: string,
  now: number = Date.now(),
): boolean {
  return computerThrottle.shouldTouch(computerId, now);
}

/**
 * May this BROWSER SESSION's command clock be touched now?
 *
 * Keyed by session rather than computer because that is the row it patches —
 * and a watched Playground box has no computer id at all. Same window, same
 * leading-edge rule: the first input after an idle stretch writes immediately,
 * so nothing is ever slept out from under somebody who just came back.
 */
export function shouldTouchSessionCommand(
  sessionId: string,
  now: number = Date.now(),
): boolean {
  return sessionCommandThrottle.shouldTouch(sessionId, now);
}

export function resetActivityThrottleForTests(): void {
  computerThrottle.reset();
  sessionCommandThrottle.reset();
}

export function trackedComputerCountForTests(): number {
  return computerThrottle.size();
}

export function trackedSessionCountForTests(): number {
  return sessionCommandThrottle.size();
}
