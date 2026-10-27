export interface SwarmSponsorshipAllowance {
  remaining: number;
  granted: number;
}

/**
 * `unsupported` is a real answer (this server or user gets no sponsored
 * conversations); `loading` and `error` are not, so a reader that sizes
 * something by the allowance can tell "none" from "unknown".
 */
export type SwarmSponsorshipAllowanceState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unsupported" }
  | ({ status: "ready" } & SwarmSponsorshipAllowance);

type Listener = (value: SwarmSponsorshipAllowanceState) => void;
type Loader = (signal: AbortSignal) => Promise<SwarmSponsorshipAllowanceState>;
const reads = new Map<
  string,
  {
    value: SwarmSponsorshipAllowanceState;
    listeners: Set<Listener>;
    refresh: () => void;
    dispose: () => void;
  }
>();

/** Share live reads and clear cached values when the last reader leaves. */
export function subscribeSwarmAllowance(
  projectId: string,
  listener: Listener,
  load: Loader,
): () => void {
  let entry = reads.get(projectId);
  if (!entry) {
    let controller: AbortController | undefined;
    entry = {
      value: { status: "loading" },
      listeners: new Set(),
      dispose: () => {},
      refresh: () => {
        controller?.abort();
        const request = new AbortController();
        controller = request;
        load(request.signal)
          .catch((): SwarmSponsorshipAllowanceState => ({ status: "error" }))
          .then((value) => {
            if (request.signal.aborted) return;
            entry!.value = value;
            for (const notify of entry!.listeners) notify(value);
          });
      },
    };
    reads.set(projectId, entry);
    // Refunds and launches from another surface can arrive after our launch.
    const timer = window.setInterval(entry.refresh, 30_000);
    window.addEventListener("focus", entry.refresh);
    entry.dispose = () => {
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", entry!.refresh);
    };
    entry.refresh();
  }
  entry.listeners.add(listener);
  listener(entry.value);
  return () => {
    entry!.listeners.delete(listener);
    if (entry!.listeners.size === 0) {
      entry!.dispose();
      reads.delete(projectId);
    }
  };
}

/** The allowance belongs to the user, so refresh every active project read. */
export function invalidateSwarmSponsorshipAllowance(): void {
  for (const entry of reads.values()) entry.refresh();
}
