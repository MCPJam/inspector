import { EventEmitter } from "events";
import type { HttpExchangeLogEvent } from "@mcpjam/sdk";
import { logger } from "../utils/logger";
import { nextRpcLogEventId } from "./rpc-log-event-id";

/** A JSON-RPC frame. `kind` is optional so existing publishers are unchanged. */
export type RpcMessageLogEvent = {
  kind?: "rpc";
  /** Stamped by {@link RpcLogBus.publish} — publishers never set it. */
  eventId?: string;
  serverId: string;
  direction: "send" | "receive";
  timestamp: string; // ISO
  message: unknown;
};

/**
 * One HTTP exchange, headers only — the envelope the frames rode in.
 *
 * A SEPARATE event kind rather than a field on the frame: the transport hands
 * us the headers when the fetch resolves, which is after the `send` frame was
 * already logged and before the `receive` frames are parsed out of the
 * response. There is no moment at which a frame and its headers are both in
 * hand, so pretending otherwise would mean holding frames back or attaching
 * headers to the wrong one.
 */
export type HttpExchangeBusEvent = {
  kind: "http";
  /** Stamped by {@link RpcLogBus.publish} — publishers never set it. */
  eventId?: string;
  serverId: string;
  timestamp: string; // ISO
  exchange: HttpExchangeLogEvent;
};

export type RpcLogEvent = RpcMessageLogEvent | HttpExchangeBusEvent;

/**
 * What subscribers and the replay buffer actually carry: the published event
 * plus the bus-assigned `eventId` (see `nextRpcLogEventId`).
 *
 * `eventId`, not `id`: a JSON-RPC frame already has an `id` of its own inside
 * `message`, and the two mean entirely different things.
 *
 * It is what makes the Logs SSE re-deliverable without duplicating rows. The
 * stream seeds every new connection with the tail of the replay buffer
 * (`?replay=N`), so any RE-subscribe — the panel unmounting and remounting, a
 * dropped EventSource, a second tab — hands the browser events it may already
 * hold. Without a stable identity the client cannot tell a re-delivery from a
 * genuinely new frame and appends it again. One id per PUBLISHED event (not per
 * method, not per JSON-RPC id) means retries and multi-round MRTR flows still
 * each get their own row.
 */
export type DeliveredRpcLogEvent = RpcLogEvent & { eventId: string };

/**
 * Attach the delivery identity to a published event.
 *
 * Generic rather than a cast: identity is established on exactly this line, so
 * it is the last place to switch the type checker off. `E extends RpcLogEvent`
 * also preserves the concrete member of the union — a frame stays a frame, an
 * exchange stays an exchange — which a plain `RpcLogEvent` return type would
 * collapse.
 */
function stampEventId<E extends RpcLogEvent>(
  event: E,
  eventId: string,
): E & { eventId: string } {
  return { ...event, eventId };
}

export function isRpcMessageLogEvent(
  event: RpcLogEvent,
): event is RpcMessageLogEvent {
  return event.kind !== "http";
}

/** Per-server replay-buffer cap, enforced on WRITE. The buffer exists only to
 *  seed the Logs SSE with recent history (`getBuffer`); without a cap a
 *  long-lived process publishing steadily (e.g. hosted harness-mcp traffic)
 *  retains every payload for the process lifetime. */
const MAX_BUFFERED_EVENTS_PER_SERVER = 500;

class RpcLogBus {
  private readonly emitter = new EventEmitter();
  private readonly bufferByServer = new Map<string, DeliveredRpcLogEvent[]>();

  publish(event: RpcLogEvent): void {
    const stamped = stampEventId(event, nextRpcLogEventId());
    const buffer = this.bufferByServer.get(stamped.serverId) ?? [];
    buffer.push(stamped);
    if (buffer.length > MAX_BUFFERED_EVENTS_PER_SERVER) {
      buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS_PER_SERVER);
    }
    this.bufferByServer.set(stamped.serverId, buffer);
    this.emitter.emit("event", stamped);
  }

  subscribe(
    serverIds: string[],
    listener: (event: DeliveredRpcLogEvent) => void,
  ): () => void {
    const filter = new Set(serverIds);
    const handler = (event: DeliveredRpcLogEvent) => {
      if (filter.size === 0 || filter.has(event.serverId)) {
        // Isolate subscribers: EventEmitter.emit re-throws synchronously, so
        // an unguarded listener would propagate into the PRODUCER — turning a
        // logging side-effect into an RPC failure (e.g. failing a harness-mcp
        // proxy call) and starving later subscribers of the same event.
        try {
          listener(event);
        } catch (error) {
          logger.warn("[rpc-log-bus] subscriber threw; event dropped for it", {
            serverId: event.serverId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  getBuffer(serverIds: string[], limit: number): DeliveredRpcLogEvent[] {
    const filter = new Set(serverIds);
    const all: DeliveredRpcLogEvent[] = [];
    for (const [serverId, buf] of this.bufferByServer.entries()) {
      if (filter.size > 0 && !filter.has(serverId)) continue;
      all.push(...buf);
    }
    // If limit is 0, return empty array (no replay)
    if (limit === 0) return [];
    // If limit is not finite or negative, return all
    if (!Number.isFinite(limit) || limit < 0) return all;
    return all.slice(Math.max(0, all.length - limit));
  }
}

export const rpcLogBus = new RpcLogBus();
