import { EventEmitter } from "events";

export type RpcLogEvent = {
  sessionId?: string;
  serverId: string;
  direction: "send" | "receive";
  timestamp: string; // ISO
  message: unknown;
};

export type RpcLogFilter = {
  serverIds: string[];
  sessionId?: string;
};

export class RpcLogBus {
  private readonly emitter = new EventEmitter();
  private readonly bufferByServer = new Map<string, RpcLogEvent[]>();

  publish(event: RpcLogEvent): void {
    const buffer = this.bufferByServer.get(event.serverId) ?? [];
    buffer.push(event);
    this.bufferByServer.set(event.serverId, buffer);
    this.emitter.emit("event", event);
  }

  subscribe(
    filter: RpcLogFilter,
    listener: (event: RpcLogEvent) => void,
  ): () => void {
    const serverFilter = new Set(filter.serverIds);
    const hasServerFilter = serverFilter.size > 0;
    const sessionFilter = filter.sessionId;
    const handler = (event: RpcLogEvent) => {
      if (!hasServerFilter) return;
      if (!serverFilter.has(event.serverId)) return;
      if (sessionFilter !== undefined && event.sessionId !== sessionFilter)
        return;
      listener(event);
    };
    this.emitter.on("event", handler);
    return () => this.emitter.off("event", handler);
  }

  getBuffer(filter: RpcLogFilter, limit: number): RpcLogEvent[] {
    const serverFilter = new Set(filter.serverIds);
    const hasServerFilter = serverFilter.size > 0;
    if (!hasServerFilter) return [];

    const all: RpcLogEvent[] = [];
    const sessionFilter = filter.sessionId;
    for (const [serverId, buf] of this.bufferByServer.entries()) {
      if (!serverFilter.has(serverId)) continue;
      if (sessionFilter === undefined) {
        all.push(...buf);
        continue;
      }

      for (const event of buf) {
        if (event.sessionId === sessionFilter) {
          all.push(event);
        }
      }
    }
    // If limit is 0, return empty array (no replay)
    if (limit === 0) return [];
    // If limit is not finite or negative, return all
    if (!Number.isFinite(limit) || limit < 0) return all;
    return all.slice(Math.max(0, all.length - limit));
  }
}

export const rpcLogBus = new RpcLogBus();
