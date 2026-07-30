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
