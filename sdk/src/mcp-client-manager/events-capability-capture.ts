/**
 * Raw capability capture for MCP Events (contract C10).
 *
 * `@modelcontextprotocol/client` 2.0.0 parses server capabilities with plain
 * `z.object` schemas (`ServerCapabilities2026Schema` and its legacy twin),
 * which silently STRIP unknown keys. A server that declares
 * `capabilities.events` — top-level, which is where the draft and OpenAI put
 * it — therefore reads as not declaring it through `getServerCapabilities()`,
 * `getDiscoverResult()` and `getInitializationInfo()` alike, even though the
 * bytes on the wire carry it.
 *
 * So the declaration is read from the RAW handshake result, observed at the
 * logging transport (the same tap `ToolDeclarationCapture` uses): outgoing
 * `initialize` / `server/discover` requests are correlated by id to their
 * responses, and `result.capabilities` is kept verbatim. Nothing is rewritten
 * and no request is sent — this only watches.
 *
 * Deliberately NOT inventing an `extensions["…"]` id: the draft has none. If
 * the draft moves the capability under `extensions`, add the alias here when
 * the draft (or a real implementation) establishes it.
 */

import type { RpcLogEvent } from "./types.js";

const HANDSHAKE_METHODS = new Set(["initialize", "server/discover"]);

/** Bound on correlated in-flight handshake ids across all servers. */
const MAX_PENDING = 256;

export interface CapturedEventsCapability {
  /** Which handshake the capabilities came from. */
  source: "initialize" | "server/discover";
  /**
   * `capabilities.events` exactly as sent, or `undefined` when the server did
   * not declare it. `{}` is a declaration (ChatGPT's documented shape).
   */
  events: Record<string, unknown> | undefined;
  /** Whether `events.listChanged === true`. */
  listChanged: boolean;
  /** The whole raw `capabilities` object, for display. */
  rawCapabilities: Record<string, unknown>;
  /** `protocolVersion` from the raw result when present. */
  protocolVersion?: string;
  observedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EventsCapabilityCapture {
  private readonly captured = new Map<string, CapturedEventsCapability>();
  private readonly pending = new Map<
    string,
    { serverId: string; method: "initialize" | "server/discover" }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Forget everything observed for a server. Called on connect, disconnect
   * and protocol switch, so a stale declaration can never outlive the
   * connection that made it — a reconnect to a server that DROPPED events
   * must read as undeclared, not as the previous answer.
   */
  clear(serverId: string): void {
    this.captured.delete(serverId);
    for (const [key, entry] of this.pending) {
      if (entry.serverId === serverId) this.pending.delete(key);
    }
  }

  read(serverId: string): CapturedEventsCapability | undefined {
    const entry = this.captured.get(serverId);
    return entry ? structuredClone(entry) : undefined;
  }

  observe(event: RpcLogEvent): void {
    const message = event.message as Record<string, unknown> | undefined;
    if (!isRecord(message) || message.id === undefined || message.id === null) {
      return;
    }
    const key = JSON.stringify([event.serverId, typeof message.id, message.id]);
    if (event.direction === "send") {
      const method = message.method;
      if (typeof method !== "string" || !HANDSHAKE_METHODS.has(method)) return;
      if (this.pending.size >= MAX_PENDING) this.pending.clear();
      this.pending.set(key, {
        serverId: event.serverId,
        method: method as "initialize" | "server/discover",
      });
      return;
    }
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    const result = message.result;
    if (!isRecord(result)) return;
    const capabilities = result.capabilities;
    if (!isRecord(capabilities)) return;
    const events = isRecord(capabilities.events)
      ? (structuredClone(capabilities.events) as Record<string, unknown>)
      : undefined;
    // `server/discover` answers with `supportedVersions`; `initialize` with
    // `protocolVersion`. Keep whichever the handshake carried.
    const protocolVersion =
      typeof result.protocolVersion === "string"
        ? result.protocolVersion
        : undefined;
    this.captured.set(request.serverId, {
      source: request.method,
      events,
      listChanged: events?.listChanged === true,
      rawCapabilities: structuredClone(capabilities),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      observedAt: this.now(),
    });
  }
}

/** The events support matrix a route, UI or CLI branches on. */
export interface EventsSupport {
  /** The raw handshake was observed on this connection. */
  handshakeObserved: boolean;
  /** The server declared `capabilities.events`. */
  declared: boolean;
  listChanged: boolean;
  capability?: Record<string, unknown>;
  source?: "initialize" | "server/discover";
}

export function resolveEventsSupport(
  captured: CapturedEventsCapability | undefined
): EventsSupport {
  if (!captured) {
    return { handshakeObserved: false, declared: false, listChanged: false };
  }
  return {
    handshakeObserved: true,
    declared: captured.events !== undefined,
    listChanged: captured.listChanged,
    ...(captured.events !== undefined ? { capability: captured.events } : {}),
    source: captured.source,
  };
}
