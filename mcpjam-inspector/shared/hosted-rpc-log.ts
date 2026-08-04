/**
 * The plugin revision that contributed the server a frame belongs to (INS-3).
 *
 * Present ONLY for a server a pinned plugin version brought into the turn, and
 * only when the backend could attribute it — absence means "not a plugin
 * server, or origin unknown", never "no plugin". Consumers must render it only
 * when it is there.
 */
export interface HostedRpcLogPluginOrigin {
  pluginId: string;
  pluginVersionId: string;
  /** Normalized plugin name — the `<plugin>/<skill>` namespace. */
  name: string;
  /** Content-addressed bundle identity; `null` under deploy skew. */
  bundleHash: string | null;
}

/**
 * Identity of ONE physically-captured event, stamped by the producing
 * `HostedRpcLogCollector` (`nextRpcLogEventId`). The browser's traffic-log
 * store keys rows on it, so an event delivered twice — streamed as a
 * `data-*-log` part AND repeated in the response envelope after a stream write
 * failed, or a response body read more than once — updates its row instead of
 * appending a copy.
 *
 * Per physical event, never per method and never per JSON-RPC id: a retry and
 * each round of a multi-round MRTR flow are separate events and keep separate
 * rows.
 *
 * Named `eventId`, NOT `id`, for two reasons. A JSON-RPC frame already carries
 * an `id` of its own inside `message` and the two mean entirely different
 * things — a reader seeing `id` next to `message.id` has to guess. And this is
 * a cross-repo shape the backend consumes too, so claiming the most generic
 * field name here would collide the day that side wants an `id` of its own.
 *
 * OPTIONAL on purpose, like every other addition to this cross-repo shape. A
 * backend that predates it emits none and the client falls back to appending —
 * version skew degrades to today's behavior rather than dropping rows.
 */
export type HostedLogEventId = string;

export interface HostedRpcLogEvent {
  eventId?: HostedLogEventId;
  serverId: string;
  serverName: string;
  direction: "send" | "receive";
  timestamp: string;
  message: unknown;
  pluginOrigin?: HostedRpcLogPluginOrigin;
}

export interface HostedRpcLogsEnvelope {
  _rpcLogs?: HostedRpcLogEvent[];
}

export interface HostedRpcLogDataPart {
  type: "data-rpc-log";
  data: HostedRpcLogEvent;
}

export function isHostedRpcLogEvent(
  value: unknown,
): value is HostedRpcLogEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverId === "string" &&
    typeof candidate.serverName === "string" &&
    (candidate.direction === "send" || candidate.direction === "receive") &&
    typeof candidate.timestamp === "string" &&
    "message" in candidate
  );
}

export function isHostedRpcLogDataPart(
  value: unknown,
): value is HostedRpcLogDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "data-rpc-log" && isHostedRpcLogEvent(candidate.data)
  );
}

/**
 * One HTTP exchange (headers only) delivered over the hosted log path — the
 * envelope the JSON-RPC frames rode in.
 *
 * A SIBLING of {@linkcode HostedRpcLogEvent}, deliberately not a widening of
 * it. Three reasons, in order of how badly each would bite:
 *
 * 1. `message` and `direction` are REQUIRED on the RPC shape and both this
 *    repo and the backend guard on them (`isHostedRpcLogEvent`). An exchange
 *    has neither — it is one request/response pair, not a directional frame —
 *    so making them optional would weaken the guard for every existing
 *    producer to describe a shape none of them emit.
 * 2. The two shapes arrive at different moments. The transport hands over
 *    headers when the fetch resolves: after the `send` frame was logged and
 *    before the `receive` frames are parsed out. There is no instant at which
 *    a frame and its headers are both in hand (see `HttpExchangeBusEvent` in
 *    `server/services/rpc-log-bus.ts`, which made the same call for the same
 *    reason).
 * 3. Additive is forward- and backward-compatible across the repo boundary. A
 *    backend that has never heard of `_httpLogs` keeps producing valid
 *    `_rpcLogs`; a client on an older build ignores an unknown envelope key
 *    and an unknown stream part. Neither side has to deploy first.
 *
 * Local mode does not use this type — it streams `HttpExchangeBusEvent`
 * straight over SSE. This exists so hosted mode reaches the same Tracing view
 * rather than staying header-blind.
 */
export interface HostedHttpLogEvent {
  /** See {@link HostedLogEventId}. Optional for the same skew reason. */
  eventId?: HostedLogEventId;
  serverId: string;
  serverName: string;
  timestamp: string;
  /**
   * Headers only, secrets redacted at capture (`wrapFetchForHttpLogging`).
   * Bodies are never captured here — the request body is already in
   * `_rpcLogs`, and reading the response body would consume the stream the
   * transport is about to parse.
   */
  exchange: import("@mcpjam/sdk/browser").HttpExchangeLogEvent;
  pluginOrigin?: HostedRpcLogPluginOrigin;
}

export interface HostedHttpLogsEnvelope {
  _httpLogs?: HostedHttpLogEvent[];
}

export interface HostedHttpLogDataPart {
  type: "data-http-log";
  data: HostedHttpLogEvent;
}

export function isHostedHttpLogEvent(
  value: unknown,
): value is HostedHttpLogEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.serverId !== "string" ||
    typeof candidate.serverName !== "string" ||
    typeof candidate.timestamp !== "string" ||
    !candidate.exchange ||
    typeof candidate.exchange !== "object"
  ) {
    return false;
  }

  // The request half is the only part the renderer cannot do without: a row
  // label comes from `request.url` and every mirrored-header verdict is
  // computed against `request.headers`. `response` is legitimately absent on a
  // transport-level failure (DNS, TLS, abort), so it is NOT required here.
  const request = (candidate.exchange as Record<string, unknown>).request;
  if (!request || typeof request !== "object") {
    return false;
  }

  const req = request as Record<string, unknown>;
  if (typeof req.method !== "string" || typeof req.url !== "string") {
    return false;
  }

  // Header VALUES are checked, not just the container. Every consumer treats
  // them as strings — `decodeMcpHeaderValue` calls `startsWith` on each — so a
  // number or null slipped in by a mis-serializing producer would throw while
  // rendering the expanded row, turning one malformed entry into a broken
  // panel. An array passes `typeof === "object"` too, hence the explicit
  // rejection.
  const headers = req.headers;
  return (
    Boolean(headers) &&
    typeof headers === "object" &&
    !Array.isArray(headers) &&
    Object.values(headers as Record<string, unknown>).every(
      (value) => typeof value === "string",
    )
  );
}

export function isHostedHttpLogDataPart(
  value: unknown,
): value is HostedHttpLogDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "data-http-log" && isHostedHttpLogEvent(candidate.data)
  );
}
