/**
 * The push (`events/stream`) seam on the official client — the phase-1 spike
 * made real.
 *
 * `events/stream` is a long-lived request: the server answers with
 * `notifications/events/*` on the request's own stream and (maybe) a final
 * empty result. Three things the official client does not give us directly:
 *
 *   1. **Stream end.** The installed transport reports a request stream that
 *      closed without a response through `TransportSendOptions.
 *      onRequestStreamEnd`, but `Protocol.request` never passes that option
 *      down — a server that drops the stream leaves the request hanging until
 *      its timer fires.
 *   2. **The request id.** Every push notification carries the parent
 *      request's JSON-RPC id in `_meta["io.modelcontextprotocol/
 *      subscriptionId"]`, but `Protocol.request` assigns the id internally.
 *   3. **One global handler per method.** Notifications route by method, so
 *      several concurrent streams on one connection need a sorting layer.
 *
 * This module is the narrow wrapper for (1) and (2): it recognizes OUR
 * `events/stream` requests by a private `_meta` key the caller stamps on them,
 * strips that key before the bytes leave, reports the assigned id, and
 * injects `onRequestStreamEnd` — while forwarding the protocol's original send
 * options, `requestSignal` included, untouched. (3) is `EventsPushRuntime`'s
 * sorting handler (`../events/push.ts`), registered once per method through
 * the notification manager so it shares, never replaces, other handlers.
 */

import type {
  JSONRPCMessage,
  JSONRPCRequest,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";

/** Private, stripped before send. Never reaches the server. */
export const EVENTS_STREAM_KEY_META = "io.mcpjam/events-stream-key" as const;

export interface EventsStreamRegistration {
  onRequestId(id: string | number): void;
  onRequestStreamEnd(): void;
}

/** Per-connection registry of in-flight `events/stream` requests we opened. */
export class EventsStreamTap {
  private readonly registrations = new Map<string, EventsStreamRegistration>();

  register(streamKey: string, registration: EventsStreamRegistration): () => void {
    this.registrations.set(streamKey, registration);
    return () => {
      if (this.registrations.get(streamKey) === registration) {
        this.registrations.delete(streamKey);
      }
    };
  }

  /** Internal: claim the registration for an outgoing message, if ours. */
  take(message: JSONRPCMessage):
    | { message: JSONRPCMessage; registration: EventsStreamRegistration; id: string | number }
    | undefined {
    // A request is the only message with both a method and an id.
    if (!("method" in message) || !("id" in message)) return undefined;
    if (message.method !== "events/stream") return undefined;
    const meta = message.params?._meta;
    const key = meta?.[EVENTS_STREAM_KEY_META];
    if (meta === undefined || typeof key !== "string") return undefined;
    const registration = this.registrations.get(key);
    const { [EVENTS_STREAM_KEY_META]: _private, ...rest } = meta;
    const stripped: JSONRPCRequest = {
      ...message,
      params: { ...message.params, _meta: rest },
    };
    if (!registration) return { message: stripped, registration: NOOP, id: message.id };
    return { message: stripped, registration, id: message.id };
  }
}

const NOOP: EventsStreamRegistration = {
  onRequestId: () => {},
  onRequestStreamEnd: () => {},
};

/**
 * Wrap a transport so `events/stream` requests stamped with
 * {@link EVENTS_STREAM_KEY_META} report their id and stream end. Compose
 * OUTSIDE the logging transport so the log shows the stripped bytes that
 * actually left.
 */
export function wrapTransportForEventStreams(
  transport: Transport,
  tap: EventsStreamTap
): Transport {
  class EventStreamsTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    constructor(private readonly inner: Transport) {
      this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
      this.inner.onclose = () => this.onclose?.();
      this.inner.onerror = (error: Error) => this.onerror?.(error);
    }

    async start(): Promise<void> {
      if (typeof this.inner.start === "function") {
        await this.inner.start();
      }
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
      const ours = tap.take(message);
      if (!ours) {
        await this.inner.send(message, options);
        return;
      }
      ours.registration.onRequestId(ours.id);
      const original = options?.onRequestStreamEnd;
      await this.inner.send(ours.message, {
        ...options,
        onRequestStreamEnd: () => {
          original?.();
          ours.registration.onRequestStreamEnd();
        },
      });
    }

    async close(): Promise<void> {
      await this.inner.close();
    }

    get sessionId(): string | undefined {
      return this.inner.sessionId;
    }

    /**
     * Forwarded, not defaulted — see `wrapTransportForLogging`: the protocol
     * reads this to decide whether cancelling a request ABORTS its stream
     * (2026-07-28) or posts `notifications/cancelled`. Per-request stream
     * cancellation of one push stream depends on it.
     */
    get hasPerRequestStream(): boolean | undefined {
      return this.inner.hasPerRequestStream;
    }

    setProtocolVersion?(version: string): void {
      if (typeof this.inner.setProtocolVersion === "function") {
        this.inner.setProtocolVersion(version);
      }
    }
  }
  return new EventStreamsTransport(transport);
}
