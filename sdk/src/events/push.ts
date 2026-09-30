/**
 * Push delivery (`events/stream`) — the local push runtime (plan phase 6),
 * built from the phase-1 spike.
 *
 * Every push stream goes through the SAME ingestion path as webhook and poll:
 * each `notifications/events/event` is appended to the inbox, and the
 * subscription's cursor advances only once the inbox has accepted it
 * (contract C5). So a trigger reacting to a pushed event is indistinguishable
 * from one reacting to a polled or webhook-delivered one.
 *
 * Draft rules (*Push-Based Delivery → Lifecycle*) and the spike's gates:
 *   - Liveness is ANY frame — an event or a heartbeat (or `active`). Nothing
 *     for more than twice the heartbeat interval ⇒ the stream is dead ⇒
 *     reconnect with the last cursor.
 *   - The default request timeout must not apply; but the official client's
 *     timer is always finite (and `setTimeout` caps at ~24.8 days), so the
 *     runtime ROLLS THE STREAM OVER deliberately before the timer can fire:
 *     cancel, reopen with the cursor. Nothing is lost — the cursor replays.
 *   - A stream the server closes without a result, or ends with one, is
 *     reopened with the cursor (bounded backoff).
 *   - Cancelling one stream aborts only that request; the connection and
 *     every other stream stay up.
 *   - Several streams share one connection: ONE sorting handler per
 *     `notifications/events/*` method demuxes by
 *     `_meta["io.modelcontextprotocol/subscriptionId"]`.
 */

import { computePollBatchId, computeBackoffMs, classifyStepFailure } from "./coordinator.js";
import { normalizeCursor, EVENTS_SUBSCRIPTION_ID_META_KEY } from "../mcp-client-manager/events-ext-schemas.js";
import {
  EventsActiveNotificationMethod,
  EventsErrorNotificationMethod,
  EventsEventNotificationMethod,
  EventsHeartbeatNotificationMethod,
  EventsTerminatedNotificationMethod,
} from "../mcp-client-manager/events-ext.js";
import { assertEventOccurrence } from "../mcp-client-manager/events-ext-guards.js";
import {
  InboxBackpressureError,
  type InboxAppendEntry,
  type InboxPort,
  type SubscriptionFailure,
  type SubscriptionRecord,
} from "./types.js";

/** Max delay for `setTimeout` (2^31 − 1 ms); longer values overflow to ~0. */
export const MAX_TIMER_MS = 2_147_483_647;

export interface PushConnectionPort {
  /** Send `events/stream`; see `MCPClientManager.openEventsStream`. */
  openStream(
    params: {
      name: string;
      arguments: Record<string, unknown>;
      cursor: string | null;
      maxAgeMs?: number;
    },
    options: {
      signal: AbortSignal;
      timeout: number;
      onRequestId: (id: string | number) => void;
      onRequestStreamEnd: () => void;
    }
  ): Promise<unknown>;
  /** Register one handler for a notification method; returns an unregister. */
  onNotification(
    method: string,
    handler: (notification: { method: string; params?: Record<string, unknown> }) => void
  ): () => void;
}

export interface PushStreamCallbacks {
  /** A cursor that is safe to persist (the inbox holds everything before it). */
  onCursor?(cursor: string | null): void;
  onState?(state: {
    observedState: "active" | "pending" | "terminated" | "paused_auth" | "error";
    failure?: SubscriptionFailure;
  }): void;
  /** Each (re)connection, for diagnostics. */
  onOpen?(info: { attempt: number; cursor: string | null; reason: string }): void;
}

export interface EventsPushRuntimeOptions {
  port: PushConnectionPort;
  inbox: InboxPort;
  clock?: { now(): number };
  /** Server heartbeat cadence the liveness window is derived from. 30 s. */
  heartbeatIntervalMs?: number;
  /** Roll the stream over after this long. ~24 days (under the timer cap). */
  rolloverMs?: number;
  maxBackoffMs?: number;
}

interface StreamState {
  record: SubscriptionRecord;
  callbacks: PushStreamCallbacks;
  cursor: string | null;
  controller?: AbortController;
  requestId?: string | number;
  livenessTimer?: ReturnType<typeof setTimeout>;
  rolloverTimer?: ReturnType<typeof setTimeout>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
  stopped: boolean;
  attempts: number;
  failures: number;
}

export interface PushStreamHandle {
  stop(): void;
  /** The JSON-RPC id of the currently open request, for tests/diagnostics. */
  readonly requestId: string | number | undefined;
  readonly cursor: string | null;
}

export class EventsPushRuntime {
  private readonly streams = new Map<string, StreamState>();
  private readonly byRequestId = new Map<string, StreamState>();
  private unregisterHandlers: Array<() => void> = [];
  private readonly heartbeatIntervalMs: number;
  private readonly rolloverMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: EventsPushRuntimeOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.rolloverMs = Math.min(
      options.rolloverMs ?? 24 * 24 * 60 * 60 * 1000,
      MAX_TIMER_MS - 60_000
    );
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
  }

  private now(): number {
    return this.options.clock?.now() ?? Date.now();
  }

  /** Open (and keep open) a push stream for `record`. */
  start(record: SubscriptionRecord, callbacks: PushStreamCallbacks = {}): PushStreamHandle {
    this.ensureHandlers();
    this.stopStream(record.id);
    const state: StreamState = {
      record,
      callbacks,
      cursor: record.lastCursor ?? null,
      queue: Promise.resolve(),
      stopped: false,
      attempts: 0,
      failures: 0,
    };
    this.streams.set(record.id, state);
    this.open(state, "start");
    return {
      stop: () => this.stopStream(record.id),
      get requestId() {
        return state.requestId;
      },
      get cursor() {
        return state.cursor;
      },
    };
  }

  /** Stop every stream and unregister the sorting handlers. */
  close(): void {
    for (const id of [...this.streams.keys()]) this.stopStream(id);
    for (const unregister of this.unregisterHandlers) unregister();
    this.unregisterHandlers = [];
  }

  openStreamCount(): number {
    return this.streams.size;
  }

  // -------------------------------------------------------------------------

  private ensureHandlers(): void {
    if (this.unregisterHandlers.length > 0) return;
    const sort = (notification: { method: string; params?: Record<string, unknown> }) => {
      const meta = notification.params?._meta as Record<string, unknown> | undefined;
      const id = meta?.[EVENTS_SUBSCRIPTION_ID_META_KEY];
      if (typeof id !== "string" && typeof id !== "number") return;
      const state = this.byRequestId.get(String(id));
      if (!state || state.stopped) return;
      // Frames of one stream are processed strictly in order.
      state.queue = state.queue
        .then(() => this.handleFrame(state, notification))
        .catch(() => undefined);
    };
    for (const method of [
      EventsActiveNotificationMethod,
      EventsEventNotificationMethod,
      EventsHeartbeatNotificationMethod,
      EventsErrorNotificationMethod,
      EventsTerminatedNotificationMethod,
    ]) {
      this.unregisterHandlers.push(this.options.port.onNotification(method, sort));
    }
  }

  private open(state: StreamState, reason: string): void {
    if (state.stopped) return;
    const controller = new AbortController();
    state.controller = controller;
    state.attempts += 1;
    state.callbacks.onOpen?.({ attempt: state.attempts, cursor: state.cursor, reason });
    this.armLiveness(state);
    // Deliberate rollover: reopen before the finite request timer can fire.
    state.rolloverTimer = setTimeout(() => {
      if (state.controller === controller) this.reconnect(state, "rollover", 0);
    }, this.rolloverMs);
    let ended = false;
    const request = this.options.port.openStream(
      {
        name: state.record.eventName,
        arguments: state.record.arguments,
        cursor: state.cursor,
        ...(state.record.maxAgeMs !== undefined ? { maxAgeMs: state.record.maxAgeMs } : {}),
      },
      {
        signal: controller.signal,
        // A safety margin past the rollover, so the rollover always wins.
        timeout: Math.min(this.rolloverMs + 60_000, MAX_TIMER_MS),
        onRequestId: (id) => {
          if (state.requestId !== undefined) this.byRequestId.delete(String(state.requestId));
          state.requestId = id;
          this.byRequestId.set(String(id), state);
        },
        onRequestStreamEnd: () => {
          ended = true;
          if (state.controller === controller) {
            this.reconnect(state, "stream_ended_without_result", this.backoff(state));
          }
        },
      }
    );
    request.then(
      () => {
        // The server closed the stream with its final result.
        if (state.controller === controller && !ended) {
          this.reconnect(state, "server_closed", this.backoff(state));
        }
      },
      (error: unknown) => {
        if (state.stopped || state.controller !== controller || controller.signal.aborted) return;
        const failure = classifyStepFailure("events/stream", error, this.now());
        if (failure.authLost) {
          state.callbacks.onState?.({ observedState: "paused_auth", failure });
          this.stopStream(state.record.id);
          return;
        }
        if (!failure.retryable) {
          state.callbacks.onState?.({ observedState: "error", failure });
          this.stopStream(state.record.id);
          return;
        }
        state.failures += 1;
        state.callbacks.onState?.({ observedState: "pending", failure });
        this.reconnect(state, `error:${failure.kind}`, this.backoff(state));
      }
    );
  }

  private backoff(state: StreamState): number {
    return computeBackoffMs(Math.max(state.failures, 1), this.maxBackoffMs);
  }

  private reconnect(state: StreamState, reason: string, delayMs: number): void {
    this.teardownRequest(state);
    if (state.stopped) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => this.open(state, reason), delayMs);
  }

  private teardownRequest(state: StreamState): void {
    clearTimeout(state.livenessTimer);
    clearTimeout(state.rolloverTimer);
    if (state.requestId !== undefined) {
      this.byRequestId.delete(String(state.requestId));
      state.requestId = undefined;
    }
    const controller = state.controller;
    state.controller = undefined;
    // Per-request cancellation: aborts THIS stream only.
    controller?.abort(new Error("events/stream closed by client"));
  }

  private armLiveness(state: StreamState): void {
    clearTimeout(state.livenessTimer);
    const controller = state.controller;
    state.livenessTimer = setTimeout(() => {
      if (state.controller === controller) {
        this.reconnect(state, "liveness_timeout", 0);
      }
    }, 2 * this.heartbeatIntervalMs);
  }

  private stopStream(id: string): void {
    const state = this.streams.get(id);
    if (!state) return;
    state.stopped = true;
    clearTimeout(state.reconnectTimer);
    this.teardownRequest(state);
    this.streams.delete(id);
  }

  private async handleFrame(
    state: StreamState,
    notification: { method: string; params?: Record<string, unknown> }
  ): Promise<void> {
    this.armLiveness(state);
    const params = notification.params ?? {};
    switch (notification.method) {
      case EventsActiveNotificationMethod: {
        state.failures = 0;
        const cursor = normalizeCursor(params.cursor as string | null | undefined);
        if (params.truncated === true) {
          await this.append(state, [{ type: "gap", cursor }], `active:${cursor}`);
        }
        this.advance(state, cursor);
        state.callbacks.onState?.({ observedState: "active" });
        return;
      }
      case EventsHeartbeatNotificationMethod:
        this.advance(state, normalizeCursor(params.cursor as string | null | undefined));
        return;
      case EventsEventNotificationMethod: {
        let event;
        try {
          const { _meta: _ignored, ...occurrence } = params;
          event = assertEventOccurrence(occurrence);
        } catch {
          return; // Malformed frame: not journalled as an event, stream stays up.
        }
        const accepted = await this.append(state, [event], `event:${event.eventId}`);
        if (accepted) this.advance(state, normalizeCursor(event.cursor));
        return;
      }
      case EventsErrorNotificationMethod:
        // Recoverable per the draft: the server retries and resumes.
        state.callbacks.onState?.({
          observedState: "active",
          failure: {
            kind: "stream_error",
            message: String((params.error as { message?: unknown } | undefined)?.message ?? "error"),
            at: this.now(),
            retryable: true,
          },
        });
        return;
      case EventsTerminatedNotificationMethod: {
        const error = params.error as { code: number; message: string; data?: unknown };
        await this.append(state, [{ type: "terminated", error }], `terminated:${this.now()}`);
        state.callbacks.onState?.({
          observedState: "terminated",
          failure: {
            kind: "terminated",
            message: String(error?.message ?? "terminated"),
            at: this.now(),
            retryable: false,
          },
        });
        this.stopStream(state.record.id);
        return;
      }
    }
  }

  private advance(state: StreamState, cursor: string | null): void {
    state.cursor = cursor;
    state.callbacks.onCursor?.(cursor);
  }

  /** Append through the shared ingestion path; `false` if not accepted. */
  private async append(
    state: StreamState,
    entries: InboxAppendEntry[],
    discriminator: string
  ): Promise<boolean> {
    try {
      await this.options.inbox.append({
        logicalSubscriptionId: state.record.id,
        projectId: state.record.projectId,
        environmentId: state.record.environmentId,
        bindingKey: state.record.bindingKey,
        batchId: computePollBatchId({
          logicalSubscriptionId: state.record.id,
          generation: state.record.generation,
          cursorBefore: state.cursor,
          eventIds: [`push:${discriminator}`],
          gap: false,
        }),
        origin: "push",
        namespace: "live",
        entries,
      });
      return true;
    } catch (error) {
      if (error instanceof InboxBackpressureError) {
        // Not journalled ⇒ the cursor must not advance. Reopen later from the
        // last committed cursor; the server replays what we could not take.
        this.reconnect(state, "inbox_backpressure", Math.max(error.retryAfterMs, 1_000));
      }
      return false;
    }
  }
}

/** A {@link PushConnectionPort} over an `MCPClientManager` connection. */
export function createManagerPushPort(
  manager: {
    openEventsStream: PushConnectionPort["openStream"] extends (
      params: infer P,
      options: infer O
    ) => Promise<unknown>
      ? (serverId: string, params: P, options: O) => Promise<unknown>
      : never;
    addNotificationHandler(serverId: string, method: string, handler: (n: any) => void): void;
    removeNotificationHandler(serverId: string, method: string, handler: (n: any) => void): void;
  },
  serverId: string
): PushConnectionPort {
  return {
    openStream: (params, options) => manager.openEventsStream(serverId, params, options),
    onNotification: (method, handler) => {
      manager.addNotificationHandler(serverId, method, handler);
      return () => manager.removeNotificationHandler(serverId, method, handler);
    },
  };
}
