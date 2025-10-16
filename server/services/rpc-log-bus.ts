import { EventEmitter } from "events";

export type RpcLogEvent = {
  serverId: string;
  direction: "send" | "receive";
  timestamp: string; // ISO
  message: unknown;
};

class RpcLogBus {
  private readonly emitter = new EventEmitter();
  private readonly bufferByServer = new Map<string, RpcLogEvent[]>();

  publish(event: RpcLogEvent): void {
    const buffer = this.bufferByServer.get(event.serverId) ?? [];
    buffer.push(event);
    this.bufferByServer.set(event.serverId, buffer);
    this.emitter.emit("event", event);
  }

  subscribe(
    serverIds: string[],
    listener: (event: RpcLogEvent) => void,
  ): () => void {
    const filter = new Set(serverIds);
    const handler = (event: RpcLogEvent) => {
      if (filter.size === 0 || filter.has(event.serverId)) listener(event);
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
