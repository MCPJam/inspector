/**
 * The runtime a turn's readiness check selected, handed to the same turn's
 * preparation so the selection is read once per turn.
 *
 * Reading it is not free: it re-verifies the cached revocation list's
 * signature and reads the install markers. The chat route asks readiness for
 * the turn's target and passes that object to the turn unchanged, so the
 * selection is keyed by it. A target that was copied or rebuilt on the way
 * (a run that adds its own session id) simply finds nothing, and preparation
 * reads the selection itself, as it always did.
 *
 * Taken once: a second preparation of the same target (a key replaced
 * mid-turn, `org-key-preparation.ts`) reads afresh. Nothing here replaces a
 * check. The availability gate still asks whether the pack may be selected
 * and is not revoked, after the lane claim, and readiness still refreshes the
 * revocation list on every turn.
 */
import type { RuntimeInstallStatus } from "./runtime-install.js";

export type ReadyRuntimeStatus = Extract<RuntimeInstallStatus, { state: "ready" }>;

const selected = new WeakMap<object, ReadyRuntimeStatus>();

/** Record the selection a target's runtime was resolved from. */
export function noteTurnRuntimeStatus(
  target: object,
  status: ReadyRuntimeStatus,
): void {
  selected.set(target, status);
}

/** The selection recorded for this exact target, at most once. */
export function takeTurnRuntimeStatus(
  target: object,
): ReadyRuntimeStatus | undefined {
  const status = selected.get(target);
  selected.delete(target);
  return status;
}
