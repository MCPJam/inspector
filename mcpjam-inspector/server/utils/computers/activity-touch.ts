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
  if (previous !== undefined && now - previous < ACTIVITY_TOUCH_THROTTLE_MS) {
    return false;
  }
  lastActivityTouchAt.set(computerId, now);
  return true;
}

export function resetActivityThrottleForTests(): void {
  lastActivityTouchAt.clear();
}
