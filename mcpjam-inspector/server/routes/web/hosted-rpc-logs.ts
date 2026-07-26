import type { UIMessageChunk } from "ai";
import type { RpcLogger } from "@mcpjam/sdk";
import { rpcLogBus } from "../../services/rpc-log-bus.js";
import { logger } from "../../utils/logger.js";
import {
  isRpcLogSinkConfigured,
  readCrossInstanceRpcLogs,
} from "../../utils/harness/harness-rpc-log-sink.js";
import type {
  HostedRpcLogEvent,
  HostedRpcLogsEnvelope,
} from "@/shared/hosted-rpc-log";

type HostedRpcChunkWriter = {
  write: (chunk: UIMessageChunk) => void;
};

function normalizeServerName(
  serverId: string,
  serverNamesById: Record<string, string>
): string {
  const resolved = serverNamesById[serverId];
  return typeof resolved === "string" && resolved.trim().length > 0
    ? resolved
    : serverId;
}

function writeHostedRpcLogDataPart(
  writer: HostedRpcChunkWriter,
  event: HostedRpcLogEvent
): void {
  writer.write({
    type: "data-rpc-log",
    data: event,
    transient: true,
  } as unknown as UIMessageChunk);
}

function readOptionalString(
  value: unknown,
  fallback?: string
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}

function mapAlignedServerNames(
  serverIds: unknown,
  serverNames: unknown
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
  body: Record<string, unknown> | null | undefined
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
    mapAlignedServerNames(body.serverIds, body.serverNames)
  );
  Object.assign(
    resolved,
    mapAlignedServerNames(body.selectedServerIds, body.selectedServerNames)
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
          { error }
        );
        this.writer = null;
        return;
      }
    }
  }
}

export function createHostedRpcLogCollector(
  body: Record<string, unknown> | null | undefined
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
 * Covers the SAME-INSTANCE case: the bus is per-process, so this alone handles
 * local dev and self-hosted. On the horizontally-scaled hosted plane a
 * harness-mcp request may land on another instance; those frames are pulled from
 * the shared Convex sink by `startCrossInstanceRpcLogPoll` (COMP-21), which pairs
 * with this bridge — start both, tear both down.
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
  collector: HostedRpcLogCollector
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

/** How often a live turn polls the shared sink for other instances' frames. */
const CROSS_INSTANCE_POLL_MS = 1000;

/**
 * COMP-21: the cross-instance half of the bridge. `bridgeHarnessRpcLogsToCollector`
 * only sees frames the LOCAL process produced; this polls the shared Convex sink
 * for frames OTHER instances wrote and feeds them into the SAME collector, so the
 * Logs panel completes even when a harness-mcp request lands on a different
 * instance than the chat stream.
 *
 * The sink read EXCLUDES this process's own instance, so a frame the bus already
 * delivered is never pulled again — the two paths never double-deliver. Dedups
 * on the sink row id (a batch write stamps one `createdAt`, so cursors are
 * inclusive and the id set prevents re-delivery of the boundary rows).
 *
 * Cursors are PER-SERVER and come from the sink's response — never derived from
 * the frames we received. Two reasons, both silent-data-loss bugs otherwise:
 * own-instance rows are filtered server-side AFTER the index scan, so a busy
 * server can yield zero frames while the scan still advanced (deriving the
 * cursor from delivered frames would stall that server for the rest of the
 * turn); and a single global cursor would let a busy server drag a quiet one
 * past rows it hasn't flushed yet.
 *
 * No-op when the sink isn't configured (single-instance / self-hosted) or the
 * turn has no servers. Best-effort throughout — a slow or erroring sink never
 * blocks the stream. Returns a stop fn callers MUST run on stream completion.
 */
export function startCrossInstanceRpcLogPoll(
  serverIds: string[],
  collector: HostedRpcLogCollector
): () => void {
  if (serverIds.length === 0 || !isRpcLogSinkConfigured()) return () => {};
  let stopped = false;
  const startedAt = Date.now(); // only frames from this turn onward
  let cursors = [...new Set(serverIds)].map((serverId) => ({
    serverId,
    sinceMs: startedAt,
  }));
  const seen = new Set<string>(); // sink row ids already delivered
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const page = await readCrossInstanceRpcLogs({ servers: cursors });
      for (const e of page.entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        collector.rpcLogger({
          direction: e.direction,
          message: e.message,
          serverId: e.serverId,
        });
      }
      cursors = page.cursors;
    } catch {
      // Best-effort; observation-only. Cursors stay put, so a failed tick
      // re-reads rather than skipping frames.
    }
    if (!stopped) {
      timer = setTimeout(tick, CROSS_INSTANCE_POLL_MS);
      timer.unref?.();
    }
  };
  timer = setTimeout(tick, CROSS_INSTANCE_POLL_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function attachHostedRpcLogs<T>(
  payload: T,
  collector?: HostedRpcLogCollector
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
