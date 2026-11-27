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
 * The beta declares io.modelcontextprotocol/events in server/discover.
 * Earlier drafts and ChatGPT use the top-level events key.
 *
 * The same tap keeps the rest of the raw handshake result that parsing drops
 * or never exposes (`serverInfo` as sent, `_meta`, `supportedVersions`), so
 * the server canvas can record the server's full declaration.
 */

import type { RpcLogEvent } from "./types.js";
import type { EventsWireProfile } from "./events-ext-guards.js";

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
  beta?: boolean;
  listChanged: boolean;
  /** The whole raw `capabilities` object, for display. */
  rawCapabilities: Record<string, unknown>;
  /** `protocolVersion` from the raw result when present. */
  protocolVersion?: string;
  /** `supportedVersions` from a `server/discover` result. */
  supportedVersions?: string[];
  /** `result.serverInfo` exactly as sent. */
  rawServerInfo?: Record<string, unknown>;
  /** `result._meta` exactly as sent. */
  rawMeta?: Record<string, unknown>;
  observedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EventsCapabilityCapture {
  private readonly betaCatalogs = new Map<string, symbol>();

  betaCatalogVersion(serverId: string): symbol | undefined {
    return this.betaCatalogs.get(serverId);
  }

  invalidateBetaCatalog(serverId: string): void {
    if (this.betaCatalogs.has(serverId)) this.betaCatalogs.set(serverId, Symbol());
  }

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
    this.betaCatalogs.delete(serverId);
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
    const extension = isRecord(capabilities.extensions)
      ? capabilities.extensions["io.modelcontextprotocol/events"] : undefined;
    const beta = request.method === "server/discover" && isRecord(extension);
    if (beta) this.betaCatalogs.set(request.serverId, Symbol());
    else this.betaCatalogs.delete(request.serverId);
    const declaration = beta ? extension : capabilities.events;
    const events = isRecord(declaration) ? structuredClone(declaration) : undefined;
    // `server/discover` answers with `supportedVersions`; `initialize` with
    // `protocolVersion`. Keep whichever the handshake carried.
    const protocolVersion =
      typeof result.protocolVersion === "string"
        ? result.protocolVersion
        : undefined;
    const supportedVersions = Array.isArray(result.supportedVersions)
      ? result.supportedVersions.filter(
          (version): version is string => typeof version === "string"
        )
      : undefined;
    this.captured.set(request.serverId, {
      source: request.method,
      events,
      ...(beta ? { beta: true } : {}),
      listChanged: events?.listChanged === true,
      rawCapabilities: structuredClone(capabilities),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(supportedVersions ? { supportedVersions } : {}),
      ...(isRecord(result.serverInfo)
        ? { rawServerInfo: structuredClone(result.serverInfo) }
        : {}),
      ...(isRecord(result._meta)
        ? { rawMeta: structuredClone(result._meta) }
        : {}),
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
  beta?: boolean;
  /** Also advertised the earlier top-level declaration alongside beta. */
  legacy?: boolean;
  listChanged: boolean;
  capability?: Record<string, unknown>;
  source?: "initialize" | "server/discover";
}

export function resolveEventsSupport(
  captured: CapturedEventsCapability | undefined,
  profile?: EventsWireProfile,
): EventsSupport {
  if (!captured) {
    return { handshakeObserved: false, declared: false, listChanged: false };
  }
  const beta = captured.beta === true && profile !== "legacy";
  const legacyCapability = captured.rawCapabilities.events;
  const capability = beta
    ? captured.events
    : profile !== "beta" && isRecord(legacyCapability)
      ? legacyCapability
      : undefined;
  return {
    handshakeObserved: true,
    ...(beta ? { beta: true, legacy: isRecord(legacyCapability) } : {}),
    declared: capability !== undefined,
    listChanged: capability?.listChanged === true,
    ...(capability !== undefined ? { capability } : {}),
    source: captured.source,
  };
}
