/**
 * Browser side of the WebMCP frame socket. Speaks the protocol served by
 * `server/routes/web/webmcp-frames.ts`:
 *
 *   client → server  text {type:"ping"} or negotiated {type:"input",seq,events}
 *   server → client  text {type:"capabilities",features:["input"]}
 *   server → client  text {type:"input_ack",seq,dispatched,refused?}
 *   server → client  binary  the daemon's own frame-stream record
 *   server → client  text {type:"pong"}
 *
 * THE PICTURE IS READ BY THE SHARED READER. A binary message here is exactly a
 * `browserd-frame-stream` record — it has been since the encoder became a thin
 * wrapper over that codec — so `createFrameWireReader` consumes it unchanged,
 * which buys this socket the Playground panes' decode policy for free: one
 * `createImageBitmap` in flight, one newest pending record, off the main
 * thread, stale sequences dropped. There is no second decoder to keep in step.
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
import type { WebMcpInputEvent } from "@/shared/webmcp-inspector-protocol";
import {
  createFrameWireReader,
  type DecodedFrame,
} from "@/lib/browser-pane/frame-wire";

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

/**
 * How often to ping. A ping keeps an idle socket off any proxy's idle timer
 * AND refreshes the session's idle deadline server-side — which is why it is
 * only sent while the document is visible (see the guard in `onopen`).
 */
export const FRAME_WS_PING_MS = 30_000;

export interface FrameStreamConnection {
  /** Undefined means not negotiated/not sent: use ordered HTTP instead. */
  sendInput(
    events: WebMcpInputEvent[],
    tabId?: string,
  ): Promise<void> | undefined;
  /**
   * Drop the picture when live view stops, without closing input.
   *
   * Releases the bitmap this connection is holding. The caller must have
   * stopped rendering it first — see `close()`.
   */
  clearFrame(): void;
  close(): void;
}

export interface OpenFrameStreamOptions {
  sessionId: string;
  /**
   * One decoded picture, newest first and never out of order.
   *
   * The `ImageBitmap` on it is BORROWED: this connection closes it when the
   * next frame arrives and when the connection is torn down, so a consumer
   * must draw it and drop the reference rather than hold or close it.
   */
  onFrame: (frame: DecodedFrame) => void;
  onOpen?: () => void;
  onInputSent?: (seq: number) => void;
  onInputAck?: (seq: number) => void;
  inputAckTimeoutMs?: number;
  onClose: (code: number, reason: string) => void;
  /** Origin override (defaults to the page origin); mainly for tests. */
  baseUrl?: string;
  /** Token override; defaults to the live session token. */
  token?: string;
  /** WebSocket factory override for tests. */
  wsFactory?: (url: string, protocols: string[]) => WebSocket;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Whether anyone can currently SEE the pane; defaults to the document's
   * visibility. Injected for tests, like the timers.
   */
  isVisible?: () => boolean;
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
  const token = opts.token;
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

  const isVisible =
    opts.isVisible ??
    (() =>
      typeof document === "undefined" ||
      document.visibilityState === "visible");

  let ping: unknown;
  let closed = false;
  /**
   * The picture currently handed out, so the next one can release it.
   *
   * An `ImageBitmap` holds a decoded surface the garbage collector cannot see
   * the cost of — several megabytes at 1024×768 — so a stream at 30fps that
   * never closed them would hold a second of decoded video at all times. The
   * CONNECTION owns them rather than the pane, because the connection is the
   * thing that knows when the stream is over.
   */
  let lastBitmap: ImageBitmap | undefined;
  const frames = createFrameWireReader({
    onFrame: (frame) => {
      if (closed) {
        frame.bitmap.close();
        return;
      }
      // Released BEFORE the new one goes out, matching the local Playground
      // pane: whoever is drawing has already been handed a newer picture, and
      // `paintFrame` tolerates a bitmap that was closed under it by reporting
      // failure rather than throwing.
      lastBitmap?.close();
      lastBitmap = frame.bitmap;
      opts.onFrame(frame);
    },
    onFatal: () => {
      // A reader that has lost its place in a byte stream can never find it
      // again. The connection goes, and the ladder decides what happens next.
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  });
  let inputEnabled = false;
  let inputTimedOut = false;
  let inputSeq = 0;
  const awaitingInput = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const abandonInput = () => {
    inputEnabled = false;
    for (const pending of awaitingInput.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          "Browser input was interrupted; it may already have executed. It was not replayed.",
        ),
      );
    }
    awaitingInput.clear();
  };
  const clearFrame = () => {
    // The reader first: a decode started before this call would otherwise land
    // afterwards and republish a picture the caller has just discarded, on a
    // socket that is still open because live view can come back.
    frames.drop();
    lastBitmap?.close();
    lastBitmap = undefined;
  };
  const clearPresentation = () => {
    closed = true;
    abandonInput();
    frames.close();
    clearFrame();
  };

  ws.onopen = () => {
    ping = setTimer(() => {
      // A ping tells the server "someone is still watching", and the server
      // refreshes the session's idle deadline on it. So it is only sent while
      // that is actually TRUE: a hidden tab already stops the screencast on
      // the same signal, and a ping from it would hold the session — a real
      // Chromium, and one of the capacity slots — unreapable for as long as
      // the tab existed anywhere in the browser. Skipping the tick (rather
      // than tearing the socket down) means a person coming back is at most
      // one interval away from claiming the session again, and if the reaper
      // won the wait the 4404 close tells the ladder the honest story.
      if (!isVisible()) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, FRAME_WS_PING_MS);
    opts.onOpen?.();
  };

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (closed) return;
    if (typeof data === "string") {
      if (data.length > 4096) return;
      let control: {
        type?: string;
        features?: unknown;
        seq?: unknown;
        dispatched?: unknown;
        refused?: unknown;
      };
      try {
        control = JSON.parse(data);
      } catch {
        return;
      }
      if (!control || typeof control !== "object") return;
      if (control.type === "capabilities" && Array.isArray(control.features)) {
        inputEnabled = !inputTimedOut && control.features.includes("input");
      } else if (
        control.type === "input_ack" &&
        typeof control.seq === "number" &&
        Number.isSafeInteger(control.seq) &&
        typeof control.dispatched === "number" &&
        Number.isSafeInteger(control.dispatched) &&
        control.dispatched >= 0 &&
        (control.refused === undefined || typeof control.refused === "string")
      ) {
        const pending = awaitingInput.get(control.seq);
        if (!pending) return;
        awaitingInput.delete(control.seq);
        clearTimeout(pending.timer);
        opts.onInputAck?.(control.seq);
        if (control.refused !== undefined)
          pending.reject(
            new Error(`Browser input was refused (${control.refused}).`),
          );
        else pending.resolve();
      }
      return;
    }
    if (!(data instanceof ArrayBuffer) || closed) return;
    // The reader decodes off the main thread and calls back with the newest
    // picture; a record it cannot read is reported through `onFatal` rather
    // than thrown, because a throw in here would take the socket down inside
    // the browser's own event dispatch.
    frames.push(data);
  };

  ws.onclose = (event: CloseEvent) => {
    clearPresentation();
    if (ping !== undefined) {
      clearTimer(ping);
      ping = undefined;
    }
    opts.onClose(event.code, event.reason ?? "");
  };
  // An error is always followed by a close; the ladder branches there.
  ws.onerror = () => {};

  return {
    clearFrame,
    sendInput(events, tabId) {
      if (closed || !inputEnabled || ws.readyState !== WebSocket.OPEN)
        return undefined;
      if (awaitingInput.size >= 16)
        return Promise.reject(
          new Error(
            "Browser input is busy. Wait for the current gesture to finish.",
          ),
        );
      const seq = ++inputSeq;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // An absent ack is an unknown outcome, never permission to replay.
          inputTimedOut = true;
          abandonInput();
          // Input falls back independently; keep binary pixels flowing.
        }, opts.inputAckTimeoutMs ?? 5_000);
        awaitingInput.set(seq, { resolve, reject, timer });
        opts.onInputSent?.(seq);
        try {
          ws.send(
            JSON.stringify({
              type: "input",
              seq,
              events,
              ...(tabId ? { tabId } : {}),
            }),
          );
        } catch {
          abandonInput();
          ws.close();
        }
      });
    },
    /**
     * Close the socket. `onClose` STILL FIRES afterwards, as it would for any
     * WebSocket: silencing it here would hide a real drop that raced the
     * close, and the caller needs one place — not two — that decides whether a
     * close is worth acting on. The store's connection generation is that
     * place.
     */
    close() {
      clearPresentation();
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
