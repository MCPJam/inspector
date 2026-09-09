/**
 * LOCAL computer terminal WebSocket bridge
 * (`GET /api/web/computers/local-terminal`).
 *
 * The "This machine" twin of `computer-terminal.ts`: same wire protocol, same
 * xterm client, but the PTY is a child process of THIS server rather than an
 * E2B sandbox. There is no control plane, no Convex row, no billing, and no
 * activity touch — the machine is always ready.
 *
 * TRUST MODEL — read before editing. This opens an INTERACTIVE shell on the
 * user's own machine, as their OS user, with no per-command approval (unlike
 * the chat `bash` tool). The gates, in order:
 *   1. `getLocalTerminalAvailability()` — hosted servers, the
 *      `MCPJAM_LOCAL_COMPUTER_ENABLED` kill switch, a bash-less machine, and a
 *      missing node-pty all degrade to a clean 4503, never a PTY.
 *   2. A single-use, 60s, project-bound nonce minted by
 *      `POST /api/mcp/computers/local-terminal-token`, which itself sits behind
 *      the inspector session token + a verified sign-in + a non-guest check +
 *      server-verified local consent. The nonce IS the auth here.
 *   3. The `Origin` header must be on the allowlist — and unlike the HTTP
 *      middleware, an ABSENT Origin is REJECTED (browsers always send one on a
 *      handshake; a non-browser client has no business opening this).
 * Nothing else reaches a PTY. This route is mounted only when `!HOSTED_MODE`.
 *
 * Wire protocol (identical to the cloud terminal, so the client is shared):
 *   client → server  binary frame            raw stdin bytes
 *   client → server  text JSON {type:"resize", cols, rows} | {type:"ping"}
 *   server → client  binary frame            raw PTY output
 *   server → client  text JSON {type:"ready", sessionId} | {type:"exit"}
 *                    | {type:"error", message} | {type:"pong"}
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { UpgradeWebSocket } from "hono/ws";
import type { MiddlewareHandler } from "hono";
import { createPtyWithCwd } from "../../utils/computers/create-pty.js";
import {
  getLocalTerminalAvailability,
  loadLocalPtyModule,
  type NodePtyProcess,
} from "../../utils/computers/local-pty.js";
import { createLocalPtyCreator } from "../../utils/computers/local-pty-adapter.js";
import { consumeLocalTerminalNonce } from "../../utils/computers/local-terminal-auth.js";
import { getLocalConsentFingerprint } from "../../utils/computers/local-consent.js";
import {
  appendLocalCommandLog,
  buildLocalCommandEnv,
  getLocalComputerWorkspaceDir,
  resolveLocalBashPath,
} from "../../utils/computers/local-machine.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { logger } from "../../utils/logger.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 500;
const MAX_ROWS = 300;

// Close codes (4xxx = application-defined) — same meanings as the cloud
// terminal, so the client's `closeMessage` mapping is shared.
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_UNAVAILABLE = 4503;

/**
 * Every live local PTY, so shutdown can kill them. `server.close()` does NOT
 * close established sockets, so without this a `Ctrl-C` on the inspector
 * leaves orphaned shells attached to the terminal's process group.
 */
const livePtys = new Set<NodePtyProcess>();

/**
 * Latched by `shutdownLocalComputerTerminals()` only. A handshake can be
 * mid-spawn when shutdown runs — `createPtyWithCwd` is awaited — and that PTY
 * would be registered AFTER the live set was drained, outliving the process.
 * The open path re-checks this after every await and kills rather than
 * registers; new handshakes are refused outright.
 *
 * This is deliberately a ONE-WAY latch for a terminating process, which is why
 * it is NOT set by `killLocalComputerTerminals()`.
 */
let shuttingDown = false;

/**
 * Bumped by every kill. A handshake captures it and re-checks after the awaits
 * in its open path, so a PTY whose spawn was already in flight when the set was
 * drained gets killed instead of registered — `livePtys.clear()` alone can't
 * see it yet, and nothing else would ever kill it.
 *
 * A monotonic counter rather than a flag, deliberately: it invalidates in-flight
 * spawns without any state that has to be cleared again afterwards, so it works
 * for the non-terminating `killLocalComputerTerminals()` path too.
 */
let ptyGeneration = 0;

/**
 * Kill every live local PTY, WITHOUT latching shutdown.
 *
 * For paths where the server goes away but the process may keep running and
 * come back — Electron's `window-all-closed` on macOS, which closes the server
 * and then restarts it on dock activation. Latching there would leave
 * `shuttingDown` true for the rest of the process lifetime and 4503 every
 * terminal handshake after the user reopened the window.
 */
export function killLocalComputerTerminals(): void {
  ptyGeneration += 1;
  for (const pty of livePtys) {
    try {
      pty.kill();
    } catch {
      // Already dead — nothing to clean up.
    }
  }
  livePtys.clear();
}

/**
 * Kill every live local PTY and refuse further ones. THE shutdown mechanism for
 * a TERMINATING process — `server/index.ts`'s `shutdown()` (standalone) and
 * `src/main.ts`'s `before-quit` (Electron). Safe to call repeatedly.
 *
 * Use `killLocalComputerTerminals()` instead when the process will survive.
 */
export function shutdownLocalComputerTerminals(): void {
  shuttingDown = true;
  killLocalComputerTerminals();
}

/** Test seam: the shutdown latch is module state for the process lifetime. */
export function resetLocalTerminalShutdownForTests(): void {
  shuttingDown = false;
  ptyGeneration = 0;
  livePtys.clear();
}

function clampDimension(
  raw: string | number | undefined,
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

/**
 * `$SHELL` if the allowlisted env carries a shell that actually exists, else
 * bash, else a bare `sh`.
 *
 * The `existsSync` check matters: a stale `SHELL` (a shell uninstalled since
 * login, or one inherited from a different container image) would make
 * node-pty's synchronous spawn throw, and the user would get "failed to open a
 * terminal" on a machine where bash is sitting right there.
 */
export function resolveLocalShell(env: NodeJS.ProcessEnv): string {
  const preferred = env.SHELL;
  if (preferred && existsSync(preferred)) return preferred;
  return resolveLocalBashPath() || "sh";
}

export function createLocalComputerTerminalWsHandler(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (err: unknown) => void }
  >
): MiddlewareHandler {
  return upgradeWebSocket(async (c) => {
    // The nonce rides the Sec-WebSocket-Protocol handshake header for the same
    // reason the cloud token does: no custom headers on a browser WS handshake,
    // and a query string would land in access logs. No fallback.
    const protocolHeader = c.req.header("sec-websocket-protocol") ?? "";
    const nonce = protocolHeader.split(",")[0]?.trim() ?? "";
    const cols = clampDimension(c.req.query("cols"), DEFAULT_COLS, MAX_COLS);
    const rows = clampDimension(c.req.query("rows"), DEFAULT_ROWS, MAX_ROWS);
    const origin = c.req.header("Origin");

    // Resolve everything we can before the socket opens; failures become an
    // immediate close-with-code in onOpen (createEvents cannot return an HTTP
    // rejection once the client has requested an upgrade).
    let rejectCode: number | null = null;
    let rejectMessage = "";
    let projectId: string | null = null;

    // Defense-in-depth: the global `originValidationMiddleware` already runs on
    // this upgrade (@hono/node-ws dispatches through app.request() with the raw
    // headers) and 403s a disallowed Origin pre-upgrade. This in-handler check
    // additionally rejects an ABSENT Origin, and covers embeddings that mount
    // the route on a bare Hono app without the global middleware.
    if (shuttingDown) {
      rejectCode = CLOSE_UNAVAILABLE;
      rejectMessage = "The inspector is shutting down.";
    } else if (!isAllowedRequestOrigin(origin)) {
      rejectCode = CLOSE_UNAUTHORIZED;
      rejectMessage = "Terminal requests must come from the inspector UI.";
    } else {
      const availability = await getLocalTerminalAvailability();
      if (!availability.available) {
        rejectCode = CLOSE_UNAVAILABLE;
        rejectMessage = `Local terminal unavailable: ${availability.reason}`;
      } else {
        // Single use: redeeming removes it, so a replayed handshake fails even
        // within the TTL.
        const claim = consumeLocalTerminalNonce(nonce);
        if (!claim) {
          rejectCode = CLOSE_UNAUTHORIZED;
          rejectMessage = "Invalid or expired terminal token.";
        } else if (
          claim.consentFingerprint !== (await getLocalConsentFingerprint())
        ) {
          // The capability that authorized this nonce is no longer the live one:
          // consent was revoked, or a re-grant from another browser profile
          // rotated it. The 60s TTL must not outlive either.
          rejectCode = CLOSE_UNAUTHORIZED;
          rejectMessage = "Local computer consent is no longer valid.";
        } else {
          projectId = claim.projectId;
        }
      }
    }

    const sessionId = randomUUID();
    // Captured at handshake: any kill between here and registration invalidates
    // this spawn (see `ptyGeneration`).
    const openGeneration = ptyGeneration;
    let pty: NodePtyProcess | null = null;
    let closed = false;
    // Only journal a `close` for a session that was journaled `open`. The open
    // write happens after the PTY spawns, so a degrade (4503) or a socket that
    // dies mid-spawn would otherwise leave a dangling close with no match.
    let journaledOpen = false;

    return {
      onOpen: (_evt, ws) => {
        if (rejectCode !== null || !projectId) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: rejectMessage || "Terminal unavailable.",
            })
          );
          ws.close(rejectCode ?? CLOSE_UNAVAILABLE, rejectMessage.slice(0, 120));
          return;
        }
        const boundProjectId = projectId;
        void (async () => {
          try {
            const loaded = await loadLocalPtyModule();
            if (!loaded.ok) {
              throw new Error(loaded.reason);
            }
            const env = buildLocalCommandEnv();
            const workspaceDir =
              await getLocalComputerWorkspaceDir(boundProjectId);
            const creator = createLocalPtyCreator({
              ptyModule: loaded.pty,
              shell: resolveLocalShell(env),
              env,
            });
            const handle = await createPtyWithCwd(
              creator,
              {
                cols,
                rows,
                // Not applicable to a local child process — the adapter ignores
                // it; the socket's lifetime is the PTY's.
                timeoutMs: 0,
                onData: (data) => {
                  if (closed) return;
                  // Copy into a standalone ArrayBuffer: WSContext.send is typed
                  // for Uint8Array<ArrayBuffer>.
                  ws.send(
                    data.buffer.slice(
                      data.byteOffset,
                      data.byteOffset + data.byteLength
                    ) as ArrayBuffer
                  );
                },
              },
              workspaceDir
            );
            if (closed || shuttingDown || openGeneration !== ptyGeneration) {
              // The socket died, the server began shutting down, or a kill swept
              // the live set while this PTY was still coming up. In every case
              // the handle is not in `livePtys` yet, so nothing else would ever
              // kill it.
              try {
                handle.kill();
              } catch {}
              return;
            }
            pty = handle;
            livePtys.add(handle);
            handle.onExit(() => {
              livePtys.delete(handle);
              if (!closed) {
                ws.send(JSON.stringify({ type: "exit" }));
                ws.close(1000, "PTY exited");
              }
            });
            // Journal the SESSION only — never the keystrokes (see
            // appendLocalCommandLog's contract).
            journaledOpen = true;
            void appendLocalCommandLog({
              ts: new Date().toISOString(),
              projectId: boundProjectId,
              commandId: sessionId,
              source: "terminal",
              action: "open",
            });
            ws.send(JSON.stringify({ type: "ready", sessionId }));
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            logger.warn("[local-computer-terminal] PTY open failed", {
              error: reason,
            });
            if (!closed) {
              // Include the underlying reason: this machine belongs to the
              // person reading the pane, and a bare "failed" turned a
              // one-line diagnosis (`posix_spawnp failed.`) into a
              // server-log hunt. Bounded so a pathological message can't
              // flood the status line.
              const detail = reason.trim().slice(0, 200);
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: detail
                    ? `Failed to open a terminal on this machine. (${detail})`
                    : "Failed to open a terminal on this machine.",
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
            typeof message.cols === "number" &&
            typeof message.rows === "number"
          ) {
            try {
              pty.resize(
                clampDimension(message.cols, DEFAULT_COLS, MAX_COLS),
                clampDimension(message.rows, DEFAULT_ROWS, MAX_ROWS)
              );
            } catch {
              // Racing a PTY that just exited; the exit handler owns the close.
            }
          }
          return;
        }
        // Binary frames are stdin. node-pty's `write` takes a string, so decode
        // as UTF-8 — non-streaming is fine because a keystroke frame is never
        // split mid-codepoint by the client (xterm sends whole `onData` chunks).
        const bytes = toUint8Array(data);
        if (bytes && pty) {
          try {
            pty.write(Buffer.from(bytes).toString("utf8"));
          } catch {
            // Same race as resize.
          }
        }
      },

      onClose: () => {
        closed = true;
        const handle = pty;
        pty = null;
        if (handle) {
          livePtys.delete(handle);
          try {
            handle.kill();
          } catch {
            // Already exited.
          }
        }
        if (projectId && journaledOpen) {
          void appendLocalCommandLog({
            ts: new Date().toISOString(),
            projectId,
            commandId: sessionId,
            source: "terminal",
            action: "close",
          });
        }
      },

      onError: (evt) => {
        logger.debug("[local-computer-terminal] websocket error", {
          event: String((evt as { type?: unknown })?.type ?? "error"),
        });
      },
    };
  });
}
