import type { UIMessageChunk } from "ai";
import type { RpcLogger } from "@mcpjam/sdk";
import { rpcLogBus } from "../../services/rpc-log-bus.js";
import { logger } from "../../utils/logger.js";
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
      try {
        writeHostedRpcLogDataPart(this.writer, this.logs[this.streamedCount]);
        this.streamedCount += 1;
      } catch (error) {
        logger.warn(
          "Hosted RPC log stream write failed; falling back to envelope delivery",
          { error },
        );
        this.writer = null;
        return;
      }
    }
  }
}

export function createHostedRpcLogCollector(
  body: Record<string, unknown> | null | undefined,
): HostedRpcLogCollector {
  return new HostedRpcLogCollector(extractServerNamesById(body));
}

/**
 * Bridge sandbox-originated harness MCP traffic into a live turn's collector.
 *
 * A harness turn's MCP calls don't flow through the chat request's manager —
 * they arrive as separate `/api/web/harness-mcp/:serverId` requests, whose
 * per-request manager publishes into the in-process `rpcLogBus` (the same bus
 * the local singleton manager feeds). Subscribing the turn's collector to the
 * bus for its selected servers routes those entries into the SAME delivery the
 * emulated engine uses (`data-rpc-log` stream parts / response envelope), so
 * the Playground Logs panel fills for harness turns with zero client changes.
 *
 * SINGLE-INSTANCE by design: the bus is per-process, so this covers local dev
 * and self-hosted. In the horizontally-scaled hosted plane a harness-mcp
 * request may land on another instance and its entries won't reach this turn —
 * cross-instance fan-in needs a shared sink (tracked as a follow-up issue).
 *
 * Scoped by serverId only (the proxy token carries no turn id), so a
 * concurrent turn against the same server on this instance would also see the
 * entries — same per-server semantics as the local-mode Logs SSE.
 *
 * Returns the unsubscribe; callers MUST run it on stream completion or the
 * collector (and its closed writer) leak on the bus for the process lifetime.
 */
export function bridgeHarnessRpcLogsToCollector(
  serverIds: string[],
  collector: HostedRpcLogCollector,
): () => void {
  // An empty filter would subscribe to EVERY server's traffic (bus semantics);
  // a harness turn with no MCP servers has nothing to bridge.
  if (serverIds.length === 0) return () => {};
  return rpcLogBus.subscribe(serverIds, (event) => {
    collector.rpcLogger({
      direction: event.direction,
      message: event.message,
      serverId: event.serverId,
    });
  });
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
