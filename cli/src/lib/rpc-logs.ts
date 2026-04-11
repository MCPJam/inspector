import type { RpcLogger } from "@mcpjam/sdk";

export interface CliRpcLogEvent {
  serverId: string;
  serverName: string;
  direction: "send" | "receive";
  timestamp: string;
  message: unknown;
}

export interface CliRpcLogsEnvelope {
  _rpcLogs?: CliRpcLogEvent[];
}

export class CliRpcLogCollector {
  private readonly logs: CliRpcLogEvent[] = [];

  constructor(private readonly serverNamesById: Record<string, string>) {}

  readonly rpcLogger: RpcLogger = ({ direction, message, serverId }) => {
    this.logs.push({
      serverId,
      serverName: this.serverNamesById[serverId] ?? serverId,
      direction,
      timestamp: new Date().toISOString(),
      message,
    });
  };

  hasLogs(): boolean {
    return this.logs.length > 0;
  }

  getLogs(): CliRpcLogEvent[] {
    return this.logs.map((event) => ({ ...event }));
  }
}

export function createCliRpcLogCollector(
  serverNamesById: Record<string, string>,
): CliRpcLogCollector {
  return new CliRpcLogCollector(serverNamesById);
}

export function attachCliRpcLogs<T>(
  payload: T,
  collector: CliRpcLogCollector | undefined,
): T | (T & CliRpcLogsEnvelope) {
  if (
    !collector?.hasLogs() ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  return {
    ...(payload as Record<string, unknown>),
    _rpcLogs: collector.getLogs(),
  } as T & CliRpcLogsEnvelope;
}
