/**
 * Browser side of the WebMCP frame socket. Speaks the protocol served by
 * `server/routes/web/webmcp-frames.ts`:
 *
 *   client → server  text {type:"ping"}
 *   server → client  binary  24-byte header + JPEG (see the shared codec)
 *   server → client  text {type:"pong"}
 *
 * Auth is the ordinary inspector session token, sent as a WebSocket
 * subprotocol (`new WebSocket(url, [token])`) — `/api/web/*` is not
 * session-gated, so the token IS the auth here, and a browser cannot attach a
 * header to a WS handshake. The same accommodation the computer terminals
 * make, for the same reason.
 *
 * Kept free of the store and of React so the wire is unit-testable behind a
 * fake WebSocket.
 */
import { decodeWebMcpBinaryFrame } from "@/shared/webmcp-inspector-protocol";
import type { WebMcpBinaryFrame } from "@/shared/webmcp-inspector-protocol";
import { getSessionToken } from "@/lib/session-token";

/**
 * Close codes the server sends, and what each one MEANS to the ladder.
 *
 * Exported because the retry policy is written in terms of them, and a policy
 * that spelled the numbers inline would drift from the route that sends them.
 */
export const FRAME_WS_CLOSE = {
  /** Ordinary close. Nothing is wrong; nothing to retry. */
  NORMAL: 1000,
  /** Token, origin — retrying cannot fix it. */
  UNAUTHORIZED: 4401,
  /** The session is over. Its SSE stream carries why. */
  GONE: 4404,
  /** Disabled or shutting down. Retrying cannot fix it either. */
  UNAVAILABLE: 4503,
} as const;

/** How often to ping, to keep an idle socket off any proxy's idle timer. */
export const FRAME_WS_PING_MS = 30_000;

export interface FrameStreamConnection {
  close(): void;
}

export interface OpenFrameStreamOptions {
  sessionId: string;
  /** One decoded frame. Called once per binary message. */
  onFrame: (frame: WebMcpBinaryFrame) => void;
  onOpen?: () => void;
  onClose: (code: number, reason: string) => void;
  /** Origin override (defaults to the page origin); mainly for tests. */
  baseUrl?: string;
  /** Token override; defaults to the live session token. */
  token?: string;
  /** WebSocket factory override for tests. */
  wsFactory?: (url: string, protocols: string[]) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Build the `ws(s)://…/api/web/webmcp/sessions/:id/frames` URL from the page
 * origin. The token is NOT in this URL — it rides the subprotocol, so it never
 * lands in a proxy or CDN access log.
 */
export function buildWebMcpFramesWsUrl(args: {
  sessionId: string;
  baseUrl?: string;
}): string {
  const origin =
    args.baseUrl ??
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
      window.location.host
    }`;
  return `${origin}/api/web/webmcp/sessions/${encodeURIComponent(
    args.sessionId,
  )}/frames`;
}

export function openWebMcpFrameStream(
  opts: OpenFrameStreamOptions,
): FrameStreamConnection {
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown);
  const clearTimer =
    opts.clearTimer ??
    ((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>));

  const url = buildWebMcpFramesWsUrl(opts);
  const token = opts.token ?? getSessionToken();
  const factory =
    opts.wsFactory ??
    ((u: string, p: string[]) =>
      // An empty subprotocol entry is a SyntaxError in the CONSTRUCTOR, not a
      // failed handshake — so a missing token would throw out of here instead
      // of closing 4401 and walking the ladder. Callers should not open this
      // without a token (the store checks), but a throw is never the right way
      // to find that out.
      p.length > 0 ? new WebSocket(u, p) : new WebSocket(u));
  const ws = factory(url, token ? [token] : []);
  ws.binaryType = "arraybuffer";

  let ping: unknown;

  ws.onopen = () => {
    ping = setTimer(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, FRAME_WS_PING_MS);
    opts.onOpen?.();
  };

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;
    // Text is control traffic only — `{type:"pong"}` today. Ignored rather
    // than parsed: nothing here acts on it.
    if (typeof data === "string") return;
    if (!(data instanceof ArrayBuffer)) return;
    const frame = decodeWebMcpBinaryFrame(data);
    // A message this client cannot read is dropped, never thrown: a throw in
    // here would take the whole socket down over one bad paint.
    if (frame) opts.onFrame(frame);
  };

  ws.onclose = (event: CloseEvent) => {
    if (ping !== undefined) {
      clearTimer(ping);
      ping = undefined;
    }
    opts.onClose(event.code, event.reason ?? "");
  };
  // An error is always followed by a close; the ladder branches there.
  ws.onerror = () => {};

  return {
    /**
     * Close the socket. `onClose` STILL FIRES afterwards, as it would for any
     * WebSocket: silencing it here would hide a real drop that raced the
     * close, and the caller needs one place — not two — that decides whether a
     * close is worth acting on. The store's connection generation is that
     * place.
     */
    close() {
      if (ping !== undefined) {
        clearTimer(ping);
        ping = undefined;
      }
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
