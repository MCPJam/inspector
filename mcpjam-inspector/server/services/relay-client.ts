/**
 * Relay client: one outbound WebSocket per tunneled server, speaking
 * `mcpjam-tunnel.v1` to the MCPJam tunnel edge. The edge sends `req`
 * control frames + binary body chunks; this client replays them against
 * the local inspector server and streams the response back frame-by-frame
 * (SSE chunks flow as they happen — nothing is buffered).
 *
 * HAND-MIRRORED CONTRACT: frame shapes, limits, and close codes mirror
 * `tunnel-edge/src/protocol.ts` in the mcpjam-backend repo. Change them
 * only together (and only by bumping the subprotocol).
 *
 * Reconnect policy:
 *  - network drops → backoff 1s→30s with jitter;
 *  - 1012 (edge restarting) → reconnect immediately;
 *  - 4000 (bad/expired token), 4002 (revoked by control plane) → PERMANENT;
 *  - 4001 (replaced) → PERMANENT by design: another inspector took the
 *    slug; auto-reconnecting would steal it back and flap forever.
 */

import http from "node:http";
import { WebSocket } from "ws";
import { logger } from "../utils/logger";

export const RELAY_SUBPROTOCOL = "mcpjam-tunnel.v1";

const CHUNK_BYTES = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_MISSED_LIMIT = 2;
const WS_BACKPRESSURE_HIGH_WATER_BYTES = 1024 * 1024;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

export const CLOSE_BAD_TOKEN = 4000;
export const CLOSE_REPLACED = 4001;
export const CLOSE_CONTROL_PLANE = 4002;
const CLOSE_EDGE_RESTART = 1012;

type ControlFrame =
  | {
      t: "hello";
      proto: number;
      slug: string;
      limits: { maxReqBody: number; chunk: number; maxInflight: number };
    }
  | {
      t: "req";
      id: number;
      method: string;
      url: string;
      headers: [string, string][];
      hasBody: boolean;
    }
  | { t: "req_end"; id: number }
  | { t: "res"; id: number; status: number; headers: [string, string][] }
  | { t: "res_end"; id: number }
  | {
      t: "abort";
      id: number;
      code:
        | "timeout"
        | "too_large"
        | "client_gone"
        | "upstream_error"
        | "overloaded";
      msg?: string;
    };

const BIN_REQ_CHUNK = 0x01;
const BIN_RES_CHUNK = 0x02;

function encodeBinaryFrame(
  kind: number,
  id: number,
  payload: Uint8Array
): Buffer {
  const buf = Buffer.allocUnsafe(5 + payload.byteLength);
  buf.writeUInt8(kind, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    buf,
    5
  );
  return buf;
}

function decodeBinaryFrame(
  data: Buffer
): { kind: number; id: number; payload: Buffer } | null {
  if (data.byteLength < 5) return null;
  return {
    kind: data.readUInt8(0),
    id: data.readUInt32BE(1),
    payload: data.subarray(5),
  };
}

export interface RelayConnectionOptions {
  serverId: string;
  slug: string;
  /** wss://agent.tunnels.mcpjam.com/agent (from the backend grant). */
  relayWsUrl: string;
  connectToken: string;
  /** Local inspector server base, e.g. http://localhost:6274 */
  localAddr: string;
  /** Public host injected by the edge; used for logging only here. */
  publicHost: string;
  onPermanentFailure?: (reason: string, closeCode: number) => void;
}

interface LocalRequest {
  req: http.ClientRequest;
  resumePoll: NodeJS.Timeout | null;
}

export class RelayConnection {
  private ws: WebSocket | null = null;
  private readonly local = new Map<number, LocalRequest>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closedByUs = false;
  private permanent: string | null = null;

  constructor(private readonly options: RelayConnectionOptions) {}

  /** Resolves on the first successful hello; rejects on permanent failure. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.close();
          reject(new Error("Timed out connecting to the tunnel relay"));
        }
      }, CONNECT_TIMEOUT_MS);
      this.dial(
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        },
        (reason) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(reason));
          }
        }
      );
    });
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get permanentFailure(): string | null {
    return this.permanent;
  }

  private dial(
    onHello?: () => void,
    onPermanent?: (reason: string) => void
  ): void {
    if (this.closedByUs || this.permanent) return;
    const ws = new WebSocket(this.options.relayWsUrl, RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${this.options.connectToken}` },
    });
    this.ws = ws;

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleBinary(data as Buffer);
        return;
      }
      let frame: ControlFrame | null = null;
      try {
        frame = JSON.parse(String(data)) as ControlFrame;
      } catch {
        return;
      }
      if (frame.t === "hello") {
        this.reconnectDelayMs = RECONNECT_MIN_MS;
        logger.info(
          `✓ Tunnel relay connected (${this.options.serverId}): ${this.options.publicHost}`
        );
        onHello?.();
        return;
      }
      this.handleControl(frame);
    });

    ws.on("pong", () => {
      this.missedPongs = 0;
    });
    ws.on("error", () => {
      // 'close' always follows.
    });
    ws.on("open", () => this.startHeartbeat());
    ws.on("close", (code, reasonBuf) => {
      this.stopHeartbeat();
      this.abortAllLocal();
      if (this.closedByUs) return;
      const reason = reasonBuf.toString() || `relay closed (${code})`;
      if (
        code === CLOSE_BAD_TOKEN ||
        code === CLOSE_REPLACED ||
        code === CLOSE_CONTROL_PLANE
      ) {
        const why =
          code === CLOSE_REPLACED
            ? "Tunnel taken over by another inspector instance — recreate the tunnel here to take it back"
            : code === CLOSE_CONTROL_PLANE
            ? "Tunnel was closed or its secret rotated elsewhere — recreate the tunnel"
            : "Tunnel session expired — recreate the tunnel";
        this.permanent = why;
        logger.warn(`Tunnel relay closed permanently (${code}): ${reason}`);
        onPermanent?.(why);
        this.options.onPermanentFailure?.(why, code);
        return;
      }
      const delay =
        code === CLOSE_EDGE_RESTART
          ? 0
          : Math.floor(this.reconnectDelayMs * (0.5 + Math.random() * 0.5));
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        RECONNECT_MAX_MS
      );
      logger.warn(
        `Tunnel relay disconnected (${code}); reconnecting in ${delay}ms`
      );
      // Never let reconnect timers stack: a stale pending timer would dial a
      // second overlapping socket on the same grant (which the edge would
      // then 4001 against the other). At most one reconnect is ever queued.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.dial(onHello), delay);
    });
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.abortAllLocal();
    try {
      this.ws?.close();
    } catch {
      this.ws?.terminate();
    }
    this.ws = null;
  }

  // ── Edge frames → local server ────────────────────────────────────────────

  private handleControl(frame: ControlFrame): void {
    if (frame.t === "req") {
      this.startLocalRequest(frame);
    } else if (frame.t === "req_end") {
      this.local.get(frame.id)?.req.end();
    } else if (frame.t === "abort") {
      const entry = this.local.get(frame.id);
      if (entry) {
        entry.req.destroy();
        this.cleanupLocal(frame.id);
      }
    }
    // 'res'/'res_end'/'hello' never arrive edge→agent beyond the handshake.
  }

  private handleBinary(data: Buffer): void {
    const frame = decodeBinaryFrame(data);
    if (!frame || frame.kind !== BIN_REQ_CHUNK) return;
    this.local.get(frame.id)?.req.write(frame.payload);
  }

  private startLocalRequest(frame: Extract<ControlFrame, { t: "req" }>): void {
    const base = new URL(this.options.localAddr);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of frame.headers) {
      const existing = headers[name];
      if (existing === undefined) headers[name] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else headers[name] = [existing, value];
    }

    const req = http.request({
      host: base.hostname,
      port: base.port || 80,
      method: frame.method,
      // Forwarded verbatim by the edge (?k= included): the adapter reads
      // the bearer secret off this URL for its SSE `endpoint` event.
      path: frame.url,
      headers,
    });
    this.local.set(frame.id, { req, resumePoll: null });

    req.on("response", (res) => {
      const responseHeaders: [string, string][] = [];
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        responseHeaders.push([
          res.rawHeaders[i] as string,
          res.rawHeaders[i + 1] as string,
        ]);
      }
      this.sendControl({
        t: "res",
        id: frame.id,
        status: res.statusCode ?? 502,
        headers: responseHeaders,
      });
      res.on("data", (chunk: Buffer) => {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          res.destroy();
          return;
        }
        for (let off = 0; off < chunk.byteLength; off += CHUNK_BYTES) {
          ws.send(
            encodeBinaryFrame(
              BIN_RES_CHUNK,
              frame.id,
              chunk.subarray(off, off + CHUNK_BYTES)
            )
          );
        }
        // Backpressure: stop reading the local response while the socket's
        // send buffer is saturated (a slow public client far away).
        if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER_BYTES) {
          res.pause();
          const entry = this.local.get(frame.id);
          if (entry && !entry.resumePoll) {
            entry.resumePoll = setInterval(() => {
              if (ws.bufferedAmount < WS_BACKPRESSURE_HIGH_WATER_BYTES / 2) {
                if (entry.resumePoll) clearInterval(entry.resumePoll);
                entry.resumePoll = null;
                res.resume();
              }
            }, 25);
          }
        }
      });
      res.on("end", () => {
        this.sendControl({ t: "res_end", id: frame.id });
        this.cleanupLocal(frame.id);
      });
      res.on("error", () => {
        this.sendControl({
          t: "abort",
          id: frame.id,
          code: "upstream_error",
        });
        this.cleanupLocal(frame.id);
      });
    });
    req.on("error", () => {
      this.sendControl({ t: "abort", id: frame.id, code: "upstream_error" });
      this.cleanupLocal(frame.id);
    });
    if (!frame.hasBody) req.end();
  }

  private cleanupLocal(id: number): void {
    const entry = this.local.get(id);
    if (entry?.resumePoll) clearInterval(entry.resumePoll);
    this.local.delete(id);
  }

  private abortAllLocal(): void {
    for (const [id, entry] of [...this.local]) {
      entry.req.destroy();
      this.cleanupLocal(id);
    }
  }

  private sendControl(frame: ControlFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // Socket closing; the close handler aborts local requests.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.missedPongs >= HEARTBEAT_MISSED_LIMIT) {
        // A slept laptop notices its dead socket here; terminate triggers
        // the close handler, which reconnects with backoff.
        ws.terminate();
        return;
      }
      this.missedPongs++;
      try {
        ws.ping();
      } catch {
        // close path follows
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
