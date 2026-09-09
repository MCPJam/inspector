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

/** Don't touch computer activity more than once a minute per computer. */
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

const lastActivityTouchAt = new Map<string, number>();

/**
 * May this computer's activity be touched now? Records the decision, so a
 * caller must only ask when it is actually about to touch.
 */
export function shouldTouchActivity(
  computerId: string,
  now: number = Date.now(),
): boolean {
  // `undefined` is kept distinct from a recorded 0: a computer nobody has
  // touched must always be eligible for its first touch, and coalescing to 0
  // makes that false whenever `now` is inside the window of the epoch.
  const previous = lastActivityTouchAt.get(computerId);
  // `now - previous` is compared as an ABSOLUTE gap, so a clock that steps
  // backwards — an NTP correction, a suspended VM waking — cannot suppress
  // every touch until real time catches up with a stamp from the future. That
  // silence would be indefinite, and would end with somebody's browser
  // hibernating underneath them while they were using it.
  if (
    previous !== undefined &&
    Math.abs(now - previous) < ACTIVITY_TOUCH_THROTTLE_MS
  ) {
    return false;
  }
  // Re-inserted rather than updated in place, so the key moves to the end of
  // the Map's insertion order and the eviction below takes a genuinely old
  // entry rather than a busy one that happened to be added first.
  lastActivityTouchAt.delete(computerId);
  lastActivityTouchAt.set(computerId, now);
  while (lastActivityTouchAt.size > MAX_TRACKED_COMPUTERS) {
    const oldest = lastActivityTouchAt.keys().next().value;
    if (oldest === undefined) break;
    lastActivityTouchAt.delete(oldest);
  }
  return true;
}

export function resetActivityThrottleForTests(): void {
  lastActivityTouchAt.clear();
}

export function trackedComputerCountForTests(): number {
  return lastActivityTouchAt.size;
}
