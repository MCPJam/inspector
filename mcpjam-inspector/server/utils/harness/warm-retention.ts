/**
 * How long a warm hosted agent is kept after its turn.
 *
 * A warm bridge stays reusable for its box's idle window, so it exits just
 * before the box pauses at its idle deadline. A pause snapshots the box's
 * memory, and the next turn's wake restores it, so a bridge still running when
 * the box pauses comes back with it. With the switch on, and the backend's
 * `retainUntil` for the box (sent only for a box its idle deadline pauses rather
 * than deletes), the bridge and its marker run to that ceiling instead. The
 * next turn's probe still checks the process, its configuration and the
 * marker's expiry before it re-attaches, and resumes from saved files when any
 * of them fails.
 */
import { harnessKeepAgentThroughPause } from "./harness-flags.js";
import type { TrustedHarnessSandboxBinding } from "./resolve-sandbox.js";

export interface WarmRetention {
  /** The box's idle window: a parked bridge stays reusable at least this long. */
  idleMs: number;
  /** The box's ceiling (epoch ms), when the bridge is kept through a pause. */
  retainUntil?: number;
}

/**
 * The retention for a warm agent on this box, or undefined when the box sent
 * no idle window (no warm agent runs there). Kept through the pause only when
 * the switch is on and the ceiling lies further out than the idle window.
 */
export function warmRetentionFor(
  binding:
    Pick<TrustedHarnessSandboxBinding, "idleMs" | "retainUntil"> | undefined,
  now = Date.now(),
): WarmRetention | undefined {
  if (binding?.idleMs === undefined) return undefined;
  const { idleMs, retainUntil } = binding;
  return harnessKeepAgentThroughPause() &&
    retainUntil !== undefined &&
    retainUntil - now > idleMs
    ? { idleMs, retainUntil }
    : { idleMs };
}

/**
 * The window a bridge started now reaps itself after: the box's remaining
 * lifetime when kept, else the idle window, and never less than the idle
 * window. The bridge counts it from its last state change, so after a later
 * turn it idles past the ceiling by the time between its start and that turn's
 * end. The marker the probe trusts still ends at the ceiling, and the box's
 * ceiling or the next spawn's reaper ends the process.
 */
export function warmBridgeWindowMs(
  retention: WarmRetention,
  now = Date.now(),
): number {
  return retention.retainUntil === undefined
    ? retention.idleMs
    : Math.max(retention.idleMs, retention.retainUntil - now);
}
