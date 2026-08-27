import { EventEmitter } from "events";
import type { HttpExchangeLogEvent } from "@mcpjam/sdk";
import { logger } from "../utils/logger";
import { nextRpcLogEventId } from "./rpc-log-event-id";
import {
  probeSerializedSize,
  truncateRpcPayload,
} from "../../shared/rpc-log-truncation";

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

/**
 * Per-FRAME retention cap.
 *
 * A count alone does not bound memory, and on the desktop app it did not. The
 * Electron main process runs this bus in-process (`server/app.ts` wires
 * `rpcLogger` for the desktop `MCPClientManager`), the SDK hands the parsed
 * frame over verbatim (`sdk/src/mcp-client-manager/transport-utils.ts`), and an
 * MCP tool that answers with a base64 image or a file dump makes 500 frames
 * worth gigabytes. INSPECTOR-ELECTRON-W3 died with 2.24 GB live in a 2.27 GB
 * old space after a full mark-compact.
 *
 * 256 KB leaves ordinary frames — including most tool results anyone actually
 * reads in the Logs panel — completely intact, and turns the ones nobody can
 * read anyway into a marker.
 */
const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * Per-server TOTAL retention cap, and the one that really bounds the process:
 * the per-frame cap alone still permits 500 x 256 KB per server, times every
 * server id ever seen.
 */
const MAX_BUFFERED_BYTES_PER_SERVER = 8 * 1024 * 1024;

/** What the buffer holds: the delivered event plus the size it was charged, so
 *  eviction can subtract without re-measuring. */
type BufferedEntry = {
  event: DeliveredRpcLogEvent;
  bytes: number;
};

type ServerBuffer = {
  entries: BufferedEntry[];
  bytes: number;
};

/**
 * What the buffer is holding right now, for `process.vitals`.
 *
 * This bus is the leading suspect for the main-process heap ramp in
 * INSPECTOR-ELECTRON-W3, and that is a claim, not a finding — there was no heap
 * snapshot. These counters make it falsifiable: if the bus is the culprit,
 * `bytes` tracks `heapUsedBytes` over a session; if it does not, the suspect is
 * somewhere else and the numbers say so.
 */
export type RpcLogBusStats = {
  servers: number;
  events: number;
  bytes: number;
  /** Cumulative since process start, NOT a gauge — how often the cap fires. */
  truncatedFrames: number;
};

class RpcLogBus {
  private readonly emitter = new EventEmitter();
  private readonly bufferByServer = new Map<string, ServerBuffer>();
  private truncatedFrames = 0;

  publish(event: RpcLogEvent): void {
    const probed = probeSerializedSize(
      isRpcMessageLogEvent(event) ? event.message : event.exchange,
      MAX_MESSAGE_BYTES,
    );

    // Replaced at CAPTURE, so the buffered copy and the copy handed to live
    // subscribers are the same object. The browser store keys rows on
    // `eventId` and upserts last-write-wins, so a replay that disagreed with
    // the live delivery would silently swap out a body the reader is already
    // looking at.
    //
    // Only `message` is replaceable. An HTTP exchange is headers-only by
    // construction and the Logs panel reads it as a typed
    // `HttpExchangeLogEvent`; it is measured and evicted like anything else,
    // just never swapped for a marker.
    const capped: RpcLogEvent =
      probed.exceeded && isRpcMessageLogEvent(event)
        ? {
            ...event,
            message: truncateRpcPayload(event.message, MAX_MESSAGE_BYTES),
          }
        : event;

    const stamped = stampEventId(capped, nextRpcLogEventId());
    // Re-probed only when the payload was actually replaced. What is left is a
    // marker plus a few scalars, so this costs nothing and beats charging the
    // buffer a made-up constant.
    let bytes: number;
    if (capped === event) {
      bytes = probed.bytes;
    } else {
      this.truncatedFrames++;
      bytes = probeSerializedSize(
        (capped as RpcMessageLogEvent).message,
        MAX_MESSAGE_BYTES,
      ).bytes;
    }

    const buffer = this.bufferByServer.get(stamped.serverId) ?? {
      entries: [],
      bytes: 0,
    };
    buffer.entries.push({ event: stamped, bytes });
    buffer.bytes += bytes;
    // The `length > 1` term keeps the newest event even when it alone is over
    // the byte ceiling, so the buffer can never evict itself empty.
    while (
      buffer.entries.length > MAX_BUFFERED_EVENTS_PER_SERVER ||
      (buffer.bytes > MAX_BUFFERED_BYTES_PER_SERVER &&
        buffer.entries.length > 1)
    ) {
      buffer.bytes -= buffer.entries.shift()!.bytes;
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
      for (const entry of buf.entries) all.push(entry.event);
    }
    // If limit is 0, return empty array (no replay)
    if (limit === 0) return [];
    // If limit is not finite or negative, return all
    if (!Number.isFinite(limit) || limit < 0) return all;
    return all.slice(Math.max(0, all.length - limit));
  }

  stats(): RpcLogBusStats {
    let events = 0;
    let bytes = 0;
    for (const buf of this.bufferByServer.values()) {
      events += buf.entries.length;
      bytes += buf.bytes;
    }
    return {
      servers: this.bufferByServer.size,
      events,
      bytes,
      truncatedFrames: this.truncatedFrames,
    };
  }

  /**
   * Drop everything retained for a server.
   *
   * The buffer is keyed by server id and nothing ever removed a key, so a
   * session that adds, renames or reconnects servers accumulated a dead
   * 500-frame bucket per id for the life of the process.
   *
   * Call this for a USER-initiated disconnect only, not from every internal
   * `removeServer()`. A failed connect also removes the entry
   * (`server/utils/local-server-resolver.ts`, `removeOnFailure`), and those
   * frames are precisely the ones the reader opened the Logs panel to see.
   */
  forgetServer(serverId: string): void {
    this.bufferByServer.delete(serverId);
  }
}

export const rpcLogBus = new RpcLogBus();
