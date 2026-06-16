/**
 * Computer terminal WebSocket bridge (`GET /api/web/computers/terminal`).
 *
 * Bridges a browser xterm.js panel to the user's personal computer's PTY
 * (E2B). Convex HTTP actions cannot hold a WebSocket open, which is the
 * whole reason this lives in the inspector server — see mcpjam-backend
 * docs/project-computers.md, "Architecture".
 *
 * Handshake / auth:
 *   - The browser first calls Convex `projectComputers.mintTerminalToken`
 *     (member-gated, ~60s TTL) and connects with `?token=<jwt>`.
 *   - We verify the token LOCALLY (shared HS256 secret) — no Convex round
 *     trip — then exchange the token's `computerId` for the vendor sandbox id
 *     via the secret-gated `/computers/sandbox-info` route. The browser never
 *     sees vendor ids or credentials.
 *   - Invalid/expired token ⇒ the socket opens and immediately closes with
 *     code 4401 (createEvents cannot return an HTTP rejection once the
 *     client requested an upgrade).
 *
 * Wire protocol (client ⇄ server):
 *   client → server  binary frame            raw stdin bytes
 *   client → server  text JSON {type:"resize", cols, rows}
 *   client → server  text JSON {type:"ping"}
 *   server → client  binary frame            raw PTY output
 *   server → client  text JSON {type:"ready", sessionId}
 *   server → client  text JSON {type:"exit"} | {type:"error", message}
 *                    | {type:"pong"}
 *
 * Sessions are recorded in Convex (`computerTerminalSessions`) on open/close;
 * the open also writes the `computer.terminal.opened` audit row backend-side.
 */
import { randomUUID } from "node:crypto";
import type { UpgradeWebSocket } from "hono/ws";
import type { MiddlewareHandler } from "hono";
import { Sandbox, type CommandHandle } from "e2b";
import { verifyComputerTerminalToken } from "../../utils/computers/terminal-token.js";
import {
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
  recordTerminalSession,
} from "../../utils/computers/control-plane-client.js";
import { logger } from "../../utils/logger.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { classifyError } from "../../utils/error-classify.js";

// PTY process TTL inside the sandbox. The E2B default is 60s, which would
// kill an idle terminal almost immediately; match the sandbox's own 1h
// running TTL instead (the idle-hibernate cron and E2B autoPause govern the
// machine's lifecycle, not the PTY's).
const PTY_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// Close codes (4xxx = application-defined).
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_UNAVAILABLE = 4503;

function clampDimension(
  raw: string | undefined,
  fallback: number,
  max: number
): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export function createComputerTerminalWsHandler(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (err: unknown) => void }
  >
): MiddlewareHandler {
  return upgradeWebSocket(async (c) => {
    const token = c.req.query("token") ?? "";
    const cols = clampDimension(c.req.query("cols"), DEFAULT_COLS, 500);
    const rows = clampDimension(c.req.query("rows"), DEFAULT_ROWS, 300);
    // Captured at upgrade time; the WS callbacks below outlive the request
    // but keep its log context (requestId, route) for typed events.
    const requestLogger = getRequestLogger(c, "routes.web.computer-terminal");

    // Resolve everything we can before the socket opens; failures become an
    // immediate close-with-code in onOpen.
    let rejectCode: number | null = null;
    let rejectMessage = "";
    let computerId: string | null = null;
    let sandboxId: string | null = null;

    if (!isComputersDataPlaneConfigured()) {
      rejectCode = CLOSE_UNAVAILABLE;
      rejectMessage = "Computers are not configured on this server.";
    } else {
      const claims = await verifyComputerTerminalToken(token);
      if (!claims) {
        rejectCode = CLOSE_UNAUTHORIZED;
        rejectMessage = "Invalid or expired terminal token.";
      } else {
        computerId = claims.computerId;
        const info = await getComputerSandboxInfo({
          computerId: claims.computerId,
        });
        if (!info.ok) {
          rejectCode = CLOSE_UNAVAILABLE;
          rejectMessage = `Computer unavailable: ${info.error}`;
        } else if (!info.value.providerComputerId) {
          rejectCode = CLOSE_UNAVAILABLE;
          rejectMessage = "Computer is still provisioning.";
        } else {
          sandboxId = info.value.providerComputerId;
        }
      }
    }

    const sessionId = randomUUID();
    let pty: CommandHandle | null = null;
    let sandbox: Sandbox | null = null;
    let closed = false;

    return {
      onOpen: (_evt, ws) => {
        if (rejectCode !== null || !sandboxId || !computerId) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: rejectMessage || "Terminal unavailable.",
            })
          );
          ws.close(
            rejectCode ?? CLOSE_UNAVAILABLE,
            rejectMessage.slice(0, 120)
          );
          return;
        }
        // Bring up the PTY asynchronously; Sandbox.connect auto-resumes a
        // paused machine, so a cold terminal open doubles as a wake.
        void (async () => {
          try {
            sandbox = await Sandbox.connect(sandboxId);
            pty = await sandbox.pty.create({
              cols,
              rows,
              timeoutMs: PTY_TIMEOUT_MS,
              onData: (data) => {
                if (closed) return;
                // Copy into a standalone ArrayBuffer: WSContext.send is typed
                // for Uint8Array<ArrayBuffer>, while the SDK hands us a view
                // over ArrayBufferLike.
                ws.send(
                  data.buffer.slice(
                    data.byteOffset,
                    data.byteOffset + data.byteLength
                  ) as ArrayBuffer
                );
              },
            });
            await recordTerminalSession({
              sessionId,
              action: "open",
              computerId,
            });
            ws.send(JSON.stringify({ type: "ready", sessionId }));
            // Surface PTY exit (shell exited, sandbox paused, TTL hit) as a
            // clean close instead of a silently dead socket.
            void pty
              .wait()
              .catch(() => {})
              .finally(() => {
                if (!closed) {
                  ws.send(JSON.stringify({ type: "exit" }));
                  ws.close(1000, "PTY exited");
                }
              });
          } catch (error) {
            requestLogger.event("computer.terminal.pty_open_failed", {
              computerId,
              errorCode: classifyError(error),
            });
            if (!closed) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Failed to open terminal on the computer.",
                })
              );
              ws.close(CLOSE_UNAVAILABLE, "PTY open failed");
            }
          }
        })();
      },

      onMessage: (evt, ws) => {
        const data = evt.data;
        // Text frames are JSON control messages.
        if (typeof data === "string") {
          let message: { type?: string; cols?: number; rows?: number };
          try {
            message = JSON.parse(data);
          } catch {
            return;
          }
          if (message.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
          if (
            message.type === "resize" &&
            pty &&
            sandbox &&
            typeof message.cols === "number" &&
            typeof message.rows === "number"
          ) {
            void sandbox.pty
              .resize(pty.pid, {
                cols: Math.min(Math.max(Math.floor(message.cols), 1), 500),
                rows: Math.min(Math.max(Math.floor(message.rows), 1), 300),
              })
              .catch(() => {});
          }
          return;
        }
        // Binary frames are stdin.
        const bytes = toUint8Array(data);
        if (bytes && pty && sandbox) {
          void sandbox.pty.sendInput(pty.pid, bytes).catch(() => {});
        }
      },

      onClose: () => {
        closed = true;
        const handle = pty;
        const box = sandbox;
        pty = null;
        void (async () => {
          try {
            if (handle && box) await box.pty.kill(handle.pid);
          } catch {
            // Sandbox may have paused/died already — nothing to clean.
          }
          await recordTerminalSession({ sessionId, action: "close" });
        })();
      },

      onError: (evt) => {
        // Socket-level errors surface to the client through onClose; this is
        // ad-hoc diagnostics only (LOGGING.md: debug is fine anywhere).
        logger.debug("[computer-terminal] websocket error", {
          event: String((evt as { type?: unknown })?.type ?? "error"),
        });
      },
    };
  });
}
