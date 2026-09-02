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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let rfb: RFB | null = null;

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

      // The token rides the subprotocol, exactly as the terminal's does: a
      // browser cannot set a header on a WS handshake, and a query string
      // would land in access logs — which is the failure this whole component
      // exists to undo.
      rfb = new RFB(container, url.toString(), {
        wsProtocols: [token],
      });
      rfbRef.current = rfb;
      rfb.viewOnly = viewOnly;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;

      rfb.addEventListener("connect", () => {
        if (disposed) return;
        setStatus("live");
        setDetail(null);
      });
      rfb.addEventListener("disconnect", (event: Event) => {
        if (disposed) return;
        const code = (event as CustomEvent<{ code?: number }>).detail?.code;
        if (code === CLOSE_UNAUTHORIZED) {
          // The 60s token expired, which is the expected way a long view ends.
          // Reconnecting mints a fresh one; nothing about the session changed.
          setStatus("connecting");
          setAttempt((n) => n + 1);
          return;
        }
        setStatus("lost");
        setDetail(
          code === 4404
            ? "The browser on this computer is no longer running."
            : "The connection to the browser dropped.",
        );
      });
    })();

    return () => {
      disposed = true;
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
