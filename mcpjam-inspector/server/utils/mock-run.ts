/**
 * Which run a mock's calls belong to, so the per-run cap on model answers
 * counts them together. A connection is built before an eval run exists, so
 * the run is told to the manager afterwards: the dispatch reads the slot on
 * every call.
 */
export interface MockRunSlot {
  key?: string;
}

const slots = new WeakMap<object, MockRunSlot>();

/** Called where a manager is built: the slot its mock connections read. */
export function registerMockRunSlot(manager: object, slot: MockRunSlot): void {
  slots.set(manager, slot);
}

/** Called once a run has an id. A key a caller already set (a harness token's run) stands. */
export function bindMockRun(manager: object, runKey: string): void {
  const slot = slots.get(manager);
  if (slot && slot.key === undefined) slot.key = runKey;
}
