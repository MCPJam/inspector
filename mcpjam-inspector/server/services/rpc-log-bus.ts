import { EventEmitter } from "events";
import { logger } from "../utils/logger";

export type RpcLogEvent = {
  serverId: string;
  direction: "send" | "receive";
  timestamp: string; // ISO
  message: unknown;
};

/** Per-server replay-buffer cap, enforced on WRITE. The buffer exists only to
 *  seed the Logs SSE with recent history (`getBuffer`); without a cap a
 *  long-lived process publishing steadily (e.g. hosted harness-mcp traffic)
 *  retains every payload for the process lifetime. */
const MAX_BUFFERED_EVENTS_PER_SERVER = 500;

class RpcLogBus {
  private readonly emitter = new EventEmitter();
  private readonly bufferByServer = new Map<string, RpcLogEvent[]>();

  publish(event: RpcLogEvent): void {
    const buffer = this.bufferByServer.get(event.serverId) ?? [];
    buffer.push(event);
    if (buffer.length > MAX_BUFFERED_EVENTS_PER_SERVER) {
      buffer.splice(0, buffer.length - MAX_BUFFERED_EVENTS_PER_SERVER);
    }
    this.bufferByServer.set(event.serverId, buffer);
    this.emitter.emit("event", event);
  }

  subscribe(
    serverIds: string[],
    listener: (event: RpcLogEvent) => void,
  ): () => void {
    const filter = new Set(serverIds);
    const handler = (event: RpcLogEvent) => {
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

  getBuffer(serverIds: string[], limit: number): RpcLogEvent[] {
    const filter = new Set(serverIds);
    const all: RpcLogEvent[] = [];
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
