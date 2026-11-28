/**
 * Observed MCP Apps bridge features (engineering spec v0.4, "3. Observed").
 *
 * The widget host hands every logged view ↔ host message to `observe`. The
 * observer classifies it with the SDK's `classifyAppsBridgeMessage`, tallies
 * the feature ids per project server, and posts each server's tallies to the
 * Inspector's observations route at most once per interval, and when the
 * page hides. Messages are
 * never kept: only the method of each in-flight view request is remembered,
 * so the host's answer to it can be classified.
 */
import {
  classifyAppsBridgeMessage,
  type BridgeDirection,
} from "@mcpjam/sdk/browser";

export interface BridgeLogEvent {
  widgetId: string;
  /** The server key the widget host logged: a server name or id. */
  serverId: string;
  direction: BridgeDirection;
  method: string;
  message: unknown;
}

export interface BridgeObservationTarget {
  projectId: string;
  serverId: string;
}

/** The body of `POST …/server-features/observations`. */
export interface BridgeObservationBatch extends BridgeObservationTarget {
  flushId: string;
  observations: Array<{
    featureId: string;
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
}

export interface AppsBridgeObserverOptions {
  /** The project server a widget's server key belongs to, if known. */
  resolveServer: (serverKey: string) => BridgeObservationTarget | null;
  /**
   * Posts one batch. Throws `ObservationWriteRefused` for a non-ok response
   * and anything else for a request that never got one.
   */
  send: (
    batch: BridgeObservationBatch,
    delivery: BridgeDelivery,
  ) => Promise<void>;
  intervalMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  newFlushId?: () => string;
}

export interface BridgeDelivery {
  /** The page is going away, so the post has to outlive it. */
  keepalive: boolean;
}

/** The observations route answered a batch with a non-ok status. */
export class ObservationWriteRefused extends Error {
  constructor(readonly status: number) {
    super(String(status));
    this.name = "ObservationWriteRefused";
  }
}

/**
 * A network error or a 5xx may pass on a second try. A 4xx is about the
 * batch or the caller's access, so sending it again gets the same answer.
 */
function isRetryable(error: unknown): boolean {
  return !(error instanceof ObservationWriteRefused) || error.status >= 500;
}

export const BRIDGE_FLUSH_INTERVAL_MS = 15_000;
export const BRIDGE_RETRY_DELAY_MS = 1_000;
/** The route accepts at most this many observations per batch. */
export const MAX_BRIDGE_OBSERVATIONS_PER_BATCH = 200;
/** View requests remembered while their answers are pending. */
export const MAX_PENDING_BRIDGE_REQUESTS = 256;

interface Tally {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

function requestKey(widgetId: string, id: unknown): string | undefined {
  return typeof id === "string" || typeof id === "number"
    ? JSON.stringify([widgetId, typeof id, id])
    : undefined;
}

function frameOf(message: unknown): { id?: unknown; method?: unknown } {
  if (typeof message !== "object" || message === null) return {};
  return {
    id: "id" in message ? message.id : undefined,
    method: "method" in message ? message.method : undefined,
  };
}

export function createAppsBridgeObserver(options: AppsBridgeObserverOptions) {
  const intervalMs = options.intervalMs ?? BRIDGE_FLUSH_INTERVAL_MS;
  const retryDelayMs = options.retryDelayMs ?? BRIDGE_RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const newFlushId = options.newFlushId ?? (() => crypto.randomUUID());
  const pending = new Map<string, string>();
  let buffers = new Map<
    string,
    { target: BridgeObservationTarget; tallies: Map<string, Tally> }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function requestMethodFor(event: BridgeLogEvent): string | undefined {
    const frame = frameOf(event.message);
    const key = requestKey(event.widgetId, frame.id);
    if (!key) return undefined;
    if (event.direction === "ui-to-host" && typeof frame.method === "string") {
      pending.delete(key);
      pending.set(key, frame.method);
      if (pending.size > MAX_PENDING_BRIDGE_REQUESTS) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      return undefined;
    }
    if (event.direction !== "host-to-ui" || frame.method !== undefined)
      return undefined;
    const method = pending.get(key);
    pending.delete(key);
    return method;
  }

  async function sendWithRetry(
    batch: BridgeObservationBatch,
    delivery: BridgeDelivery,
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await options.send(batch, delivery);
        return;
      } catch (error) {
        // A retryable failure is retried once, after a pause, with the same
        // flushId, which the backend treats as one write. Anything else drops
        // the batch: observations are evidence the next use of the view
        // records again, not data the user entered.
        if (attempt > 0 || !isRetryable(error)) return;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  /**
   * Sends everything tallied so far. The buffers are swapped out before any
   * post starts, so a later flush never sends the same tallies again.
   */
  async function flush(
    delivery: BridgeDelivery = { keepalive: false },
  ): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const drained = buffers;
    buffers = new Map();
    const batches: BridgeObservationBatch[] = [];
    for (const { target, tallies } of drained.values()) {
      const observations = [...tallies].map(([featureId, tally]) => ({
        featureId,
        ...tally,
      }));
      for (
        let start = 0;
        start < observations.length;
        start += MAX_BRIDGE_OBSERVATIONS_PER_BATCH
      ) {
        batches.push({
          ...target,
          flushId: newFlushId(),
          observations: observations.slice(
            start,
            start + MAX_BRIDGE_OBSERVATIONS_PER_BATCH,
          ),
        });
      }
    }
    // Started together: a flush as the page hides has only that moment.
    await Promise.all(batches.map((batch) => sendWithRetry(batch, delivery)));
  }

  function observe(event: BridgeLogEvent): void {
    const requestMethod = requestMethodFor(event);
    const featureIds = classifyAppsBridgeMessage(event, requestMethod);
    if (featureIds.length === 0) return;
    const target = options.resolveServer(event.serverId);
    if (!target) return;
    const key = JSON.stringify([target.projectId, target.serverId]);
    const buffer = buffers.get(key) ?? { target, tallies: new Map() };
    buffers.set(key, buffer);
    const at = now();
    for (const featureId of featureIds) {
      const tally = buffer.tallies.get(featureId);
      if (tally) {
        tally.count += 1;
        tally.lastSeenAt = at;
      } else {
        buffer.tallies.set(featureId, {
          count: 1,
          firstSeenAt: at,
          lastSeenAt: at,
        });
      }
    }
    timer ??= setTimeout(() => void flush(), intervalMs);
  }

  return { observe, flush };
}

/**
 * Calls `flush` when the page is hidden or unloaded, so a reload or a closed
 * tab within one interval does not lose the tallies. Closing a tab fires
 * both events; the second flush finds nothing left to send. Returns the
 * listeners' removal.
 */
export function flushWhenPageHides(flush: () => void): () => void {
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") flush();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
