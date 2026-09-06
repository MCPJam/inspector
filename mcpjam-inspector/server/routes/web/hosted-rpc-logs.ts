import type { UIMessageChunk } from "ai";
import type { HttpExchangeLogger, RpcLogger } from "@mcpjam/sdk";
import { isRpcMessageLogEvent, rpcLogBus } from "../../services/rpc-log-bus.js";
import { logger } from "../../utils/logger.js";
import {
  isRpcLogSinkConfigured,
  readCrossInstanceRpcLogs,
} from "../../utils/harness/harness-rpc-log-sink.js";
import { consumeCrossInstanceHarnessScopeStepUpMessage } from "../../utils/harness/harness-scope-step-up.js";
import { consumeCrossInstanceHarnessPolicyBlockMessage } from "../../utils/harness/harness-policy-block-channel.js";
import { nextRpcLogEventId } from "../../services/rpc-log-event-id.js";
import type {
  HostedHttpLogEvent,
  HostedHttpLogsEnvelope,
  HostedRpcLogEvent,
  HostedRpcLogPluginOrigin,
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

/**
 * The header half, on its own stream part. A client that predates
 * `data-http-log` drops an unrecognized part, so this cannot break an older
 * build the way a changed `data-rpc-log` payload would.
 */
function writeHostedHttpLogDataPart(
  writer: HostedRpcChunkWriter,
  event: HostedHttpLogEvent
): void {
  writer.write({
    type: "data-http-log",
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
  /**
   * HTTP exchanges (headers only), buffered separately from the JSON-RPC
   * frames because they are a separate delivery shape — see
   * `HostedHttpLogEvent`. Same lifecycle as `logs`: buffered until a writer
   * attaches, then streamed, and always available for envelope delivery.
   */
  private readonly httpLogs: HostedHttpLogEvent[] = [];
  private httpStreamedCount = 0;

  /**
   * INS-3 plugin provenance, keyed by server id. Set AFTER construction
   * because the collector is built from the raw body (before auth) while
   * plugin origin only exists once the environment has resolved. Frames logged
   * before that point simply carry no origin — absence is honest, and no MCP
   * traffic can precede manager construction anyway.
   */
  private pluginOriginByServerId: Record<string, HostedRpcLogPluginOrigin> = {};

  constructor(private readonly serverNamesById: Record<string, string>) {}

  setPluginOriginByServerId(
    origins: Record<string, HostedRpcLogPluginOrigin>
  ): void {
    this.pluginOriginByServerId = origins;
  }

  readonly rpcLogger: RpcLogger = ({ direction, message, serverId }) => {
    const pluginOrigin = this.pluginOriginByServerId[serverId];
    const event: HostedRpcLogEvent = {
      // Stamped once, HERE, at CAPTURE — not at delivery. Both deliveries read
      // the same buffered event, so a frame that is streamed as a
      // `data-rpc-log` part and then repeated in the response envelope (see
      // `flushBufferedLogs`, which drops the writer and falls back to envelope
      // delivery mid-turn) carries the SAME id both times, and the browser
      // store keys them onto one row instead of two.
      eventId: nextRpcLogEventId(),
      serverId,
      serverName: normalizeServerName(serverId, this.serverNamesById),
      direction,
      timestamp: new Date().toISOString(),
      message,
      ...(pluginOrigin ? { pluginOrigin } : {}),
    };

    this.logs.push(event);
    this.flushBufferedLogs();
  };

  /**
   * The SDK's headers-only HTTP channel, wired wherever `rpcLogger` is.
   *
   * `serverId` comes off the exchange itself (the SDK stamps it in
   * `wrapFetchForHttpLogging`) rather than from a closure, so one collector
   * serves a multi-server turn exactly as `rpcLogger` does.
   */
  readonly httpLogger: HttpExchangeLogger = (exchange) => {
    const pluginOrigin = this.pluginOriginByServerId[exchange.serverId];
    this.httpLogs.push({
      // Same discipline as `rpcLogger`: identity belongs to the captured
      // exchange, not to whichever delivery happens to carry it.
      eventId: nextRpcLogEventId(),
      serverId: exchange.serverId,
      serverName: normalizeServerName(exchange.serverId, this.serverNamesById),
      timestamp: new Date().toISOString(),
      exchange,
      ...(pluginOrigin ? { pluginOrigin } : {}),
    });
    this.flushBufferedLogs();
  };

  /**
   * True when the turn produced ANY log of either kind. Callers gate envelope
   * attachment on this (`attachHostedRpcLogs`), so it must count HTTP
   * exchanges too — a doctor run that only captured headers would otherwise
   * have its envelope dropped on the floor.
   */
  hasLogs(): boolean {
    return this.logs.length > 0 || this.httpLogs.length > 0;
  }

  getLogs(): HostedRpcLogEvent[] {
    return this.logs.map((event) => ({ ...event }));
  }

  getHttpLogs(): HostedHttpLogEvent[] {
    return this.httpLogs.map((event) => ({ ...event }));
  }

  attachStreamWriter(writer: HostedRpcChunkWriter): void {
    this.writer = writer;
    this.flushBufferedLogs();
  }

  buildEnvelope(): HostedRpcLogsEnvelope & HostedHttpLogsEnvelope {
    return {
      ...(this.logs.length > 0 ? { _rpcLogs: this.getLogs() } : {}),
      ...(this.httpLogs.length > 0 ? { _httpLogs: this.getHttpLogs() } : {}),
    };
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

    while (this.httpStreamedCount < this.httpLogs.length) {
      try {
        writeHostedHttpLogDataPart(
          this.writer,
          this.httpLogs[this.httpStreamedCount]
        );
        this.httpStreamedCount += 1;
      } catch (error) {
        logger.warn(
          "Hosted HTTP log stream write failed; falling back to envelope delivery",
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
    // Both kinds bridge now: HTTP exchanges ride their own delivery shape
    // (`data-http-log` parts / `_httpLogs`), so hosted reaches the same
    // Tracing view local mode has instead of staying header-blind.
    //
    // Still NOT covered: the cross-instance Convex sink
    // (`startCrossInstanceRpcLogPoll`) carries JSON-RPC frames only, so a
    // harness-mcp request that lands on another instance contributes its
    // frames but not its headers. That needs a matching backend change; the
    // gap is per-instance and additive, never a wrong header.
    if (!isRpcMessageLogEvent(event)) {
      collector.httpLogger(event.exchange);
      return;
    }
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
        if (consumeCrossInstanceHarnessScopeStepUpMessage(e.message)) {
          continue;
        }
        // Same contract for the policy-block control frame: delivered as data,
        // never rendered as a JSON-RPC frame in the Logs panel.
        if (consumeCrossInstanceHarnessPolicyBlockMessage(e.message)) {
          continue;
        }
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
): T | (T & HostedRpcLogsEnvelope & HostedHttpLogsEnvelope) {
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
  } as T & HostedRpcLogsEnvelope & HostedHttpLogsEnvelope;
}
