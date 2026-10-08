import type { BoundResourceAdapter } from "../resource-grants.js";

/** Exclusive disposable in-memory CAS fixture; never an ordinary filesystem adapter. */
export function managedResourceFixture(initial = "disposable café\n") {
  let bytes = new TextEncoder().encode(initial);
  let version = 1;
  let writes = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const adapter: BoundResourceAdapter = {
    read: async (_key, signal) => {
      signal.throwIfAborted();
      return {
        bytes: bytes.slice(),
        etag: `fixture-v${version}`,
        mimeType: "text/plain",
      };
    },
    conditionalWrite: async (_key, next, ifMatch, signal) => {
      signal.throwIfAborted();
      if (ifMatch !== undefined && ifMatch !== `fixture-v${version}`)
        return { outcome: "conflict", etag: `fixture-v${version}` };
      bytes = next.slice();
      writes++;
      version++;
      changed();
      return { outcome: "saved", etag: `fixture-v${version}` };
    },
    watch: async (_key, listener, signal) => {
      signal.throwIfAborted();
      listeners.add(listener);
      const stop = () => {
        listeners.delete(listener);
        signal.removeEventListener("abort", stop);
      };
      signal.addEventListener("abort", stop, { once: true });
      return stop;
    },
  };
  return { adapter, listeners, changed, writes: () => writes };
}
