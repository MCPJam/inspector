export interface HostedRpcLogEvent {
  serverId: string;
  serverName: string;
  direction: "send" | "receive";
  timestamp: string;
  message: unknown;
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
