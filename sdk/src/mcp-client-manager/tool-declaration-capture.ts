import type { RpcLogEvent } from "./types.js";
import type { TranscriptToolInventoryEntry } from "../predicates/types.js";

type Declaration = TranscriptToolInventoryEntry & { outputSchema?: unknown };
type Snapshot = {
  tools: Declaration[];
  capture: "complete" | "partial";
  generation: number;
  nextCursor?: string;
  cursors: Set<string>;
  bytes: number;
  ambiguous: boolean;
};

/** Observes raw tools/list frames without changing requests, responses, or paging. */
export class ToolDeclarationCapture {
  private snapshots = new Map<string, Snapshot>();
  private pending = new Map<
    string,
    { serverId: string; generation: number; cursor?: string }
  >();
  private generation = 0;

  clear(serverId: string): void {
    this.snapshots.delete(serverId);
    for (const [key, request] of this.pending) {
      if (request.serverId === serverId) this.pending.delete(key);
    }
  }

  read(
    serverId: string
  ): { tools: Declaration[]; capture: "complete" | "partial" } | undefined {
    const snapshot = this.snapshots.get(serverId);
    return snapshot
      ? { tools: structuredClone(snapshot.tools), capture: snapshot.capture }
      : undefined;
  }

  observe(event: RpcLogEvent): void {
    const message = event.message as Record<string, unknown>;
    if (!message || typeof message !== "object" || message.id == null) return;
    const key = JSON.stringify([event.serverId, typeof message.id, message.id]);
    if (event.direction === "send") {
      if (message.method !== "tools/list") return;
      const params = message.params as { cursor?: string } | undefined;
      const cursor = params?.cursor;
      let snapshot = this.snapshots.get(event.serverId);
      if (cursor === undefined) {
        snapshot = {
          tools: [],
          capture: "partial",
          generation: ++this.generation,
          cursors: new Set(),
          bytes: 0,
          ambiguous: [...this.pending.values()].some(
            (request) => request.serverId === event.serverId
          ),
        };
        this.snapshots.set(event.serverId, snapshot);
      } else if (
        !snapshot ||
        snapshot.capture === "complete" ||
        snapshot.nextCursor !== cursor ||
        snapshot.cursors.has(cursor)
      ) {
        // An isolated debugger page is not a complete catalog observation.
        return;
      }
      if (this.pending.size >= 512) {
        this.clear(event.serverId);
        return;
      }
      this.pending.set(key, {
        serverId: event.serverId,
        generation: snapshot.generation,
        cursor,
      });
      if (cursor !== undefined) snapshot.cursors.add(cursor);
      return;
    }
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    const snapshot = this.snapshots.get(request.serverId);
    if (!snapshot || snapshot.generation !== request.generation) return;
    const result = message.result as
      { tools?: unknown; nextCursor?: unknown } | undefined;
    if (message.error || !result || !Array.isArray(result.tools)) return;
    const page: Declaration[] = [];
    for (const value of result.tools) {
      if (!value || typeof value !== "object" || typeof value.name !== "string")
        return;
      const tool: Declaration = {
        name: value.name,
        ...(typeof value.description === "string"
          ? { description: value.description }
          : {}),
        ...(value.inputSchema !== undefined
          ? { inputSchema: value.inputSchema }
          : {}),
        ...(value.outputSchema !== undefined
          ? { outputSchema: value.outputSchema }
          : {}),
        ...(value.annotations &&
        typeof value.annotations === "object" &&
        !Array.isArray(value.annotations)
          ? { annotations: value.annotations }
          : {}),
      };
      snapshot.bytes += new TextEncoder().encode(
        JSON.stringify(tool)
      ).byteLength;
      if (
        snapshot.bytes > 4 * 1024 * 1024 ||
        snapshot.tools.length + page.length >= 10_000
      )
        return;
      page.push(structuredClone(tool));
    }
    snapshot.tools.push(...page);
    if (result.nextCursor === undefined) {
      snapshot.capture = snapshot.ambiguous ? "partial" : "complete";
      snapshot.nextCursor = undefined;
    } else if (
      typeof result.nextCursor === "string" &&
      !snapshot.cursors.has(result.nextCursor)
    ) {
      snapshot.nextCursor = result.nextCursor;
    } else {
      // A repeated/invalid cursor leaves capture partial, even if the SDK
      // later returns an aggregate with that cursor silently removed.
      snapshot.nextCursor = undefined;
    }
  }
}
