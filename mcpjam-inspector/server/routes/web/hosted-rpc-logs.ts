import type { UIMessageChunk } from "ai";
import type { RpcLogger } from "@mcpjam/sdk";
import type {
  HostedRpcLogEvent,
  HostedRpcLogsEnvelope,
} from "@/shared/hosted-rpc-log";

type HostedRpcChunkWriter = {
  write: (chunk: UIMessageChunk) => void;
};

function normalizeServerName(
  serverId: string,
  serverNamesById: Record<string, string>,
): string {
  const resolved = serverNamesById[serverId];
  return typeof resolved === "string" && resolved.trim().length > 0
    ? resolved
    : serverId;
}

function writeHostedRpcLogDataPart(
  writer: HostedRpcChunkWriter,
  event: HostedRpcLogEvent,
): void {
  writer.write({
    type: "data-rpc-log",
    data: event,
    transient: true,
  } as unknown as UIMessageChunk);
}

function readOptionalString(
  value: unknown,
  fallback?: string,
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function mapAlignedServerNames(
  serverIds: unknown,
  serverNames: unknown,
): Record<string, string> {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    return {};
  }

  const names = Array.isArray(serverNames) ? serverNames : [];
  const resolved: Record<string, string> = {};

  serverIds.forEach((serverId, index) => {
    if (typeof serverId !== "string" || serverId.trim().length === 0) {
      return;
    }

    resolved[serverId] = readOptionalString(names[index], serverId) ?? serverId;
  });

  return resolved;
}

function extractServerNamesById(
  body: Record<string, unknown> | null | undefined,
): Record<string, string> {
  if (!body) {
    return {};
  }

  const resolved: Record<string, string> = {};

  if (typeof body.serverId === "string") {
    resolved[body.serverId] =
      readOptionalString(body.serverName, body.serverId) ?? body.serverId;
  }

  Object.assign(
    resolved,
    mapAlignedServerNames(body.serverIds, body.serverNames),
  );
  Object.assign(
    resolved,
    mapAlignedServerNames(body.selectedServerIds, body.selectedServerNames),
  );

  if (typeof body.serverUrl === "string") {
    resolved.__guest__ =
      readOptionalString(body.serverName, "__guest__") ?? "__guest__";
  }

  return resolved;
}

export class HostedRpcLogCollector {
  private readonly logs: HostedRpcLogEvent[] = [];
  private streamedCount = 0;
  private writer: HostedRpcChunkWriter | null = null;

  constructor(private readonly serverNamesById: Record<string, string>) {}

  readonly rpcLogger: RpcLogger = ({ direction, message, serverId }) => {
    const event: HostedRpcLogEvent = {
      serverId,
      serverName: normalizeServerName(serverId, this.serverNamesById),
      direction,
      timestamp: new Date().toISOString(),
      message,
    };

    this.logs.push(event);
    this.flushBufferedLogs();
  };

  hasLogs(): boolean {
    return this.logs.length > 0;
  }

  getLogs(): HostedRpcLogEvent[] {
    return this.logs.map((event) => ({ ...event }));
  }

  attachStreamWriter(writer: HostedRpcChunkWriter): void {
    this.writer = writer;
    this.flushBufferedLogs();
  }

  buildEnvelope(): HostedRpcLogsEnvelope {
    return this.hasLogs() ? { _rpcLogs: this.getLogs() } : {};
  }

  private flushBufferedLogs(): void {
    if (!this.writer) {
      return;
    }

    while (this.streamedCount < this.logs.length) {
      writeHostedRpcLogDataPart(this.writer, this.logs[this.streamedCount]);
      this.streamedCount += 1;
    }
  }
}

export function createHostedRpcLogCollector(
  body: Record<string, unknown> | null | undefined,
): HostedRpcLogCollector {
  return new HostedRpcLogCollector(extractServerNamesById(body));
}

export function attachHostedRpcLogs<T>(
  payload: T,
  collector?: HostedRpcLogCollector,
): T | (T & HostedRpcLogsEnvelope) {
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
    ...collector.buildEnvelope(),
  } as T & HostedRpcLogsEnvelope;
}
