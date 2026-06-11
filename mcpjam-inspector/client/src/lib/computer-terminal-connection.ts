/**
 * Browser side of the computer terminal WebSocket bridge. Speaks the protocol
 * served by the inspector server (`server/routes/web/computer-terminal.ts`):
 *
 *   client → server  binary frame        raw stdin bytes
 *   client → server  text {type:"resize",cols,rows} | {type:"ping"}
 *   server → client  binary frame        raw PTY output
 *   server → client  text {type:"ready",sessionId} | {type:"exit"}
 *                    | {type:"error",message} | {type:"pong"}
 *
 * Auth is the Convex-minted terminal token in the query string (the
 * `/api/web/*` routes are not session-gated; the token IS the auth). Kept
 * free of xterm so the protocol is unit-testable with a fake WebSocket.
 */

export type TerminalEvent =
  | { type: "ready"; sessionId: string }
  | { type: "exit" }
  | { type: "error"; message: string };

export interface TerminalConnection {
  sendInput(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Liveness ping; server replies with pong (ignored). */
  ping(): void;
  close(): void;
}

export interface OpenTerminalOptions {
  token: string;
  cols: number;
  rows: number;
  onOutput: (data: Uint8Array) => void;
  onEvent: (event: TerminalEvent) => void;
  onOpen?: () => void;
  onClose: (code: number, reason: string) => void;
  /** Origin override (defaults to the current page origin); mainly for tests. */
  baseUrl?: string;
  /** WebSocket factory override for tests. */
  wsFactory?: (url: string) => WebSocket;
}

/** Build the `ws(s)://…/api/web/computers/terminal?…` URL from page origin. */
export function buildTerminalWsUrl(args: {
  token: string;
  cols: number;
  rows: number;
  baseUrl?: string;
}): string {
  const origin =
    args.baseUrl ??
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
      window.location.host
    }`;
  const params = new URLSearchParams({
    token: args.token,
    cols: String(args.cols),
    rows: String(args.rows),
  });
  return `${origin}/api/web/computers/terminal?${params.toString()}`;
}

export function openTerminalConnection(
  opts: OpenTerminalOptions
): TerminalConnection {
  const url = buildTerminalWsUrl(opts);
  const ws = (opts.wsFactory ?? ((u: string) => new WebSocket(u)))(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => opts.onOpen?.();

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === "string") {
      let message: { type?: string; sessionId?: string; message?: string };
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === "ready") {
        opts.onEvent({
          type: "ready",
          sessionId: String(message.sessionId ?? ""),
        });
      } else if (message.type === "exit") {
        opts.onEvent({ type: "exit" });
      } else if (message.type === "error") {
        opts.onEvent({
          type: "error",
          message: String(message.message ?? "Terminal error"),
        });
      }
      // {type:"pong"} and anything unknown is ignored.
      return;
    }
    // Binary PTY output.
    if (data instanceof ArrayBuffer) {
      opts.onOutput(new Uint8Array(data));
    }
  };

  ws.onclose = (event: CloseEvent) =>
    opts.onClose(event.code, event.reason ?? "");
  // Errors are always followed by a close; surface via onClose only.
  ws.onerror = () => {};

  const sendIfOpen = (payload: string | ArrayBufferView) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload as never);
  };

  return {
    sendInput: (bytes) => sendIfOpen(bytes),
    resize: (cols, rows) =>
      sendIfOpen(JSON.stringify({ type: "resize", cols, rows })),
    ping: () => sendIfOpen(JSON.stringify({ type: "ping" })),
    close: () => ws.close(),
  };
}
