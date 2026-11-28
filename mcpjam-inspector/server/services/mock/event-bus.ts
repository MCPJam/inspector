/**
 * The change events a mock's `subscriptions/listen` streams hear (2026-07-28).
 *
 * Two sources reach one stream:
 * - the shared bus: one per caller, mock and version in this process, so a
 *   stream open on one request hears a change a saved case raised on another
 *   (the runtime publishes to it);
 * - the stream's own feed from the real server (`real-changes.ts`), which only
 *   the request that opened the stream listens to. Keeping it private means two
 *   streams of one caller never hear a real change twice.
 *
 * Nothing about access lives here: the bus carries no credential or record,
 * and an entry is dropped when its last request ends.
 */
import type { BuildMockOptions } from "@mcpjam/sdk/mocks";

export type MockEventBus = NonNullable<BuildMockOptions["bus"]>;
export type MockChangeEvent = Parameters<MockEventBus["publish"]>[0];

/** An in-process bus; a listener that throws does not stop the others. */
export function createEventBus(onError: (error: unknown) => void): MockEventBus {
  const listeners = new Set<(event: MockChangeEvent) => void>();
  return {
    publish: (event) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          onError(error);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const shared = new Map<string, { bus: MockEventBus; users: number }>();

/**
 * The shared bus for one caller's use of one mock version. `release` must be
 * called when the request ends; the last release drops the bus.
 */
export function acquireSharedBus(
  key: string,
  onError: (error: unknown) => void,
): { bus: MockEventBus; release: () => void } {
  let entry = shared.get(key);
  if (!entry) {
    entry = { bus: createEventBus(onError), users: 0 };
    shared.set(key, entry);
  }
  entry.users += 1;
  const held = entry;
  let released = false;
  return {
    bus: held.bus,
    release: () => {
      if (released) return;
      released = true;
      held.users -= 1;
      if (held.users === 0 && shared.get(key) === held) shared.delete(key);
    },
  };
}

/** Publishes to the shared bus; a listener hears the shared bus and the feed. */
export function withFeed(sharedBus: MockEventBus, feed: MockEventBus): MockEventBus {
  return {
    publish: (event) => sharedBus.publish(event),
    subscribe: (listener) => {
      const stops = [sharedBus.subscribe(listener), feed.subscribe(listener)];
      return () => stops.forEach((stop) => stop());
    },
  };
}

/** How many shared buses are open (for tests). */
export const openSharedBuses = () => shared.size;
