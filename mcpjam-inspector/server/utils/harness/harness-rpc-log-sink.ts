// Cross-instance harness RPC-log sink — inspector side (COMP-21).
//
// A harness's MCP tool calls arrive as separate `/api/web/harness-mcp/:serverId`
// requests FROM the sandbox; on the scaled hosted plane one can land on a
// different instance than the one streaming the chat turn. Same-instance frames
// ride the in-process `rpcLogBus`; this module ALSO writes each frame to a shared
// Convex sink (batched) and lets a streaming turn PULL the frames OTHER instances
// wrote — completing the Logs panel across instances.
//
// Hard rules (observation-only): a sink failure must NEVER slow or fail a proxy
// request — every path here is best-effort and swallowed. Never token material,
// only the JSON-RPC payloads. Bounded on write (per-message size cap here; TTL
// reaper on the backend).

import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";

/** Stable per-PROCESS id. The reader excludes its own instance so bus-delivered
 *  (same-instance) frames aren't also pulled from Convex — the dedup that lets
 *  both delivery paths coexist. */
const INSTANCE_ID = randomUUID();
export function getInspectorInstanceId(): string {
  return INSTANCE_ID;
}

const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFER_ENTRIES = 50;
const MAX_BUFFER_BYTES = 256 * 1024;
/** Per-frame cap. An oversized frame becomes a marker — never dropped, never
 *  allowed to blow the Convex document limit. */
const MESSAGE_CAP_BYTES = 16 * 1024;

export type HarnessRpcLogEntry = {
  serverId: string;
  projectId?: string;
  organizationId?: string;
  direction: "send" | "receive";
  loggedAt: string; // ISO
  message: unknown;
};

export type CrossInstanceRpcLogEntry = {
  id: string;
  serverId: string;
  direction: "send" | "receive";
  loggedAt: string;
  message: unknown;
  createdAt: number;
};

function convexBase(): string | null {
  return process.env.CONVEX_HTTP_URL?.trim() || null;
}
function serviceToken(): string | null {
  return process.env.INSPECTOR_SERVICE_TOKEN?.trim() || null;
}

/** The sink only operates when this inspector can reach Convex with the service
 *  token. Absent ⇒ single-instance / self-hosted: the in-process bus is the only
 *  (and sufficient) delivery path, exactly as before COMP-21. */
export function isRpcLogSinkConfigured(): boolean {
  return Boolean(convexBase() && serviceToken());
}

function capMessage(message: unknown): unknown {
  try {
    const s = JSON.stringify(message);
    if (s.length > MESSAGE_CAP_BYTES) {
      return { _truncated: true, bytes: s.length };
    }
    return message;
  } catch {
    return { _truncated: true, reason: "unserializable" };
  }
}

let buffer: HarnessRpcLogEntry[] = [];
let bufferBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Buffer one frame for the shared sink. Flushes when the buffer hits a count or
 * byte threshold, else on a ~1s timer — NEVER one Convex write per frame.
 * Best-effort: any failure is swallowed so the proxy request is untouched.
 */
export function enqueueHarnessRpcLog(entry: HarnessRpcLogEntry): void {
  if (!isRpcLogSinkConfigured()) return;
  try {
    const capped: HarnessRpcLogEntry = {
      ...entry,
      message: capMessage(entry.message),
    };
    buffer.push(capped);
    try {
      bufferBytes += JSON.stringify(capped).length;
    } catch {
      bufferBytes += MESSAGE_CAP_BYTES;
    }
    if (
      buffer.length >= MAX_BUFFER_ENTRIES ||
      bufferBytes >= MAX_BUFFER_BYTES
    ) {
      void flushHarnessRpcLogs();
    } else if (!flushTimer) {
      flushTimer = setTimeout(
        () => void flushHarnessRpcLogs(),
        FLUSH_INTERVAL_MS
      );
      // Don't keep the process alive for a pending log flush.
      flushTimer.unref?.();
    }
  } catch (err) {
    logger.warn(
      `[harness-rpc-log-sink] enqueue failed: ${
        err instanceof Error ? err.message : err
      }`
    );
  }
}

/** Flush the buffer to Convex now. Best-effort; a failed flush drops the batch
 *  (observation-only) rather than retrying and risking unbounded growth. */
export async function flushHarnessRpcLogs(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (buffer.length === 0) return;
  const base = convexBase();
  const token = serviceToken();
  const entries = buffer;
  buffer = [];
  bufferBytes = 0;
  if (!base || !token) return;
  try {
    await fetch(new URL("/harness/rpc-logs/write", base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": token,
      },
      body: JSON.stringify({
        entries: entries.map((e) => ({ ...e, instanceId: INSTANCE_ID })),
      }),
    });
  } catch (err) {
    logger.warn(
      `[harness-rpc-log-sink] flush failed (${
        entries.length
      } entries dropped): ${err instanceof Error ? err.message : err}`
    );
  }
}

export type RpcLogCursor = { serverId: string; sinceMs: number };

export type CrossInstanceRpcLogPage = {
  entries: CrossInstanceRpcLogEntry[];
  /** Per-server cursors for the NEXT read. Adopt these verbatim — see below. */
  cursors: RpcLogCursor[];
};

/**
 * Read frames OTHER instances wrote for these servers since a PER-SERVER cursor.
 * Excludes this instance (its frames arrived via the bus). Best-effort: any
 * failure yields no entries and UNCHANGED cursors, so a slow/erroring sink never
 * blocks a turn's stream and never silently skips frames.
 *
 * The caller must adopt the returned `cursors` rather than deriving them from
 * `entries`. Own-instance rows are filtered server-side AFTER the index scan, so
 * a window full of them yields zero entries while the scan still made progress —
 * a cursor derived from delivered rows would never advance and that server would
 * go blind for the rest of the turn.
 */
export async function readCrossInstanceRpcLogs(args: {
  servers: RpcLogCursor[];
  limit?: number;
}): Promise<CrossInstanceRpcLogPage> {
  const unchanged: CrossInstanceRpcLogPage = {
    entries: [],
    cursors: args.servers,
  };
  const base = convexBase();
  const token = serviceToken();
  if (!base || !token || args.servers.length === 0) return unchanged;
  try {
    const res = await fetch(new URL("/harness/rpc-logs/read", base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": token,
      },
      body: JSON.stringify({
        servers: args.servers,
        excludeInstanceId: INSTANCE_ID,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      }),
    });
    if (!res.ok) return unchanged;
    const body = (await res.json()) as {
      entries?: CrossInstanceRpcLogEntry[];
      cursors?: RpcLogCursor[];
    };
    const cursors = Array.isArray(body.cursors)
      ? body.cursors.filter(
          (c): c is RpcLogCursor =>
            !!c &&
            typeof c.serverId === "string" &&
            typeof c.sinceMs === "number" &&
            Number.isFinite(c.sinceMs)
        )
      : [];
    return {
      entries: Array.isArray(body.entries) ? body.entries : [],
      // A response without usable cursors must not rewind or drop progress.
      cursors: cursors.length > 0 ? cursors : args.servers,
    };
  } catch {
    return unchanged;
  }
}

/** Test-only: drop buffered state + pending timer between cases. */
export function __resetHarnessRpcLogSinkForTest(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  buffer = [];
  bufferBytes = 0;
}
