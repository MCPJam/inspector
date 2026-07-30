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

export interface HostedRpcLogEvent {
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
  return (
    typeof req.method === "string" &&
    typeof req.url === "string" &&
    Boolean(req.headers) &&
    typeof req.headers === "object"
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
