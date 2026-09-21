/**
 * The live view of a computer's browser, over the inspector's own RFB proxy.
 *
 * Replaces an `<iframe>` pointed at E2B's noVNC page with the desktop password
 * in its query string. That password is not a view credential — the daemon's
 * handoff lease gates model-driven commands, not VNC input, and `view_only` is
 * a flag the client applies to itself — so in the URL it was full keyboard and
 * mouse on the member's desktop, readable from the DOM, from
 * `document.referrer`, and from anything that logs iframe sources.
 *
 * Here the browser connects to `/api/web/computers/browser/stream`, which
 * authenticates upstream server-side and offers this end security type `None`.
 * There is no password on this side to leak, and the input gate is enforced on
 * the server, where a client cannot opt out of it. `viewOnly` below is
 * therefore a courtesy — it stops a stray click from being sent at all — and
 * not a control anything depends on.
 */
import { useEffect, useRef, useState } from "react";
// The package's single export; it ships no types, so the shape this file
// relies on is declared in `types/novnc.d.ts`.
import RFB from "@novnc/novnc";

interface BrowserStreamProps {
  /** Mints a fresh ~60s browser token. Called per connect, never cached. */
  mintToken: () => Promise<string>;
  /** False while the agent holds the browser: don't even send the events. */
  viewOnly: boolean;
  /** The current boot; a change means a relaunched daemon and a new stream. */
  bootId: string;
}

/** Close codes the server sends. 4401 is recoverable — mint a new token. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GONE = 4404;
/**
 * The two ways a HEALTHY stream ends without the server deciding anything:
 * `1001` is a replica draining (every deploy to this environment does it) and
 * `1006` is the socket dying with no close frame at all. Both are the same
 * situation from here — the far end went away and will be back — and both were
 * previously terminal, so a routine deploy left a member staring at "The
 * connection to the browser dropped." over a browser that was still running.
 */
const CLOSE_GOING_AWAY = 1001;
const CLOSE_ABNORMAL = 1006;
/** Bounded, so a token rejected for any OTHER reason cannot spin forever. */
const MAX_RECONNECTS = 5;
const RECONNECT_DELAY_MS = 500;

export interface StreamCloseOutcome {
  /** Reconnect (with a fresh token), rather than showing a dead pane. */
  retry: boolean;
  /** What to show if this is the end of the line. */
  detail: string;
}

/**
 * What a close code means, as a pure function so the policy is testable
 * without a socket, a DOM, or noVNC.
 *
 * `reason` is the server's own sentence — the stream proxy sends real ones
 * ("Could not reach the browser stream.", "The browser stream did not
 * respond.") and dropping them on the floor is how an explained failure
 * reaches a member as an unexplained one.
 */
export function streamCloseOutcome(event: {
  code: number;
  reason?: string;
}): StreamCloseOutcome {
  const reason = event.reason?.trim();
  switch (event.code) {
    case CLOSE_UNAUTHORIZED:
      // The 60s token expired, which is how a long view normally ends.
      return { retry: true, detail: "The browser session expired." };
    case CLOSE_GOING_AWAY:
    case CLOSE_ABNORMAL:
      return { retry: true, detail: "The connection to the browser dropped." };
    case CLOSE_GONE:
      return {
        retry: false,
        detail: "The browser on this computer is no longer running.",
      };
    default:
      return {
        retry: false,
        detail: reason || "The connection to the browser dropped.",
      };
  }
}

/**
 * Back off between reconnects rather than retrying five times in 2.5s: the
 * common cause is a deploy, and a replica needs longer than that to come back.
 * 0.5s → 8s across the five attempts, ~15s in total.
 */
export function reconnectDelayMs(consecutive: number): number {
  return RECONNECT_DELAY_MS * 2 ** Math.max(0, consecutive - 1);
}

export function BrowserStream({
  mintToken,
  viewOnly,
  bootId,
}: BrowserStreamProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "lost">(
    "connecting",
  );
  const [detail, setDetail] = useState<string | null>(null);
  /** Bumped to force a reconnect; see the 4401 path below. */
  const [attempt, setAttempt] = useState(0);
  /**
   * CONSECUTIVE reconnects, not reconnects ever.
   *
   * `attempt` never resets, so after five expired tokens across a long viewing
   * session — the normal way a 60s token ends — every later expiry stopped
   * reconnecting and the pane went dead for good. What the cap is for is a
   * token being rejected for some OTHER reason, which shows up as failures
   * back to back; a connection that succeeded in between proves it was not
   * that.
   */
  const consecutiveRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // A new boot is a new stream. Leaving the previous status up shows "lost"
    // over a connection that is being established, or "live" over one that is
    // already gone.
    setStatus("connecting");
    setDetail(null);
    let disposed = false;
    let rfb: RFB | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      let token: string;
      try {
        token = await mintToken();
      } catch (cause) {
        if (disposed) return;
        setStatus("lost");
        setDetail(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (disposed) return;

      const url = new URL(
        "/api/web/computers/browser/stream",
        window.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

      // The socket is built HERE and handed to noVNC, rather than letting it
      // build one from a URL, because the close CODE is the only thing that
      // distinguishes an expired token from a browser that is gone — and
      // noVNC's own `disconnect` event reports `{clean}` and nothing else.
      //
      // The token rides the subprotocol, exactly as the terminal's does: a
      // browser cannot set a header on a WS handshake, and a query string
      // would land in access logs, which is the failure this whole component
      // exists to undo.
      const socket = new WebSocket(url.toString(), [token]);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("close", (event) => {
        if (disposed) return;
        const outcome = streamCloseOutcome(event);
        if (outcome.retry && consecutiveRef.current < MAX_RECONNECTS) {
          consecutiveRef.current += 1;
          // Reconnecting mints a fresh token; nothing about the session
          // changed. Capped and backed off, so a socket failing for some other
          // reason cannot spin.
          setStatus("connecting");
          retry = setTimeout(
            () => setAttempt((n) => n + 1),
            reconnectDelayMs(consecutiveRef.current),
          );
          return;
        }
        setStatus("lost");
        setDetail(outcome.detail);
      });

      rfb = new RFB(container, socket);
      rfbRef.current = rfb;
      rfb.viewOnly = viewOnly;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;

      rfb.addEventListener("connect", () => {
        if (disposed) return;
        // Proof the failures before this were transient, so the budget for
        // back-to-back ones starts over.
        consecutiveRef.current = 0;
        setStatus("live");
        setDetail(null);
      });
      // noVNC's own disconnect carries only `{clean}`, so it cannot say WHY.
      // The socket's close event above owns that; this just covers a failure
      // that never reached a close at all.
      rfb.addEventListener("disconnect", () => {
        if (disposed || socket.readyState === WebSocket.CLOSED) return;
        setStatus("lost");
        setDetail("The connection to the browser dropped.");
      });
    })();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      try {
        rfb?.disconnect();
      } catch {
        /* already gone */
      }
      rfbRef.current = null;
    };
    // `bootId` is a dependency on purpose: a relaunched daemon means a new
    // stream with new credentials, and the old socket is pointed at a VNC
    // server that no longer exists.
  }, [mintToken, bootId, attempt]);

  // Applied without reconnecting: the lease can change hands many times during
  // one view, and tearing the stream down to reflect that would blank the
  // picture every time somebody took or released control.
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} className="h-full w-full" />
      {status !== "live" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 text-xs text-muted-foreground">
          {status === "connecting"
            ? "Connecting to the browser…"
            : (detail ?? "The connection to the browser dropped.")}
        </div>
      ) : null}
    </div>
  );
}

export default BrowserStream;
