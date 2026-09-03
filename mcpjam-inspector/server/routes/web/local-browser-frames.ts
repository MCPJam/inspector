/**
 * The live picture of the local agent browser — `/api/web/computers/local-browser/frames`.
 *
 * The model reads the page through screenshots on its command results. A
 * PERSON needs to watch it move and, when the agent hits a CAPTCHA or an SSO
 * prompt, take over. That is this socket: JPEG frames out, and (through the
 * separate `/local-browser/input` route) their pointer and keys back in.
 *
 * The handshake is the local terminal's, deliberately, down to the close
 * codes: a single-use nonce in `Sec-WebSocket-Protocol` (a browser cannot set
 * headers on a WS handshake, and a query string lands in access logs), an
 * Origin that must be present and allowed, and a re-check that the consent
 * capability the nonce was minted against is still the live one — so revoking
 * consent, or re-granting it from another browser profile, invalidates
 * anything already handed out.
 *
 * What it adds over the terminal's: the daemon's LEASE decides who may watch.
 * While a person holds the browser, only they receive frames — a second pane
 * showing someone's password field as they type it is the same leak as an
 * agent screenshotting it, and the lease is the only thing that knows whose
 * hands are on the page.
 */
import type { MiddlewareHandler } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { logger } from "../../utils/logger.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { getLocalConsentFingerprint } from "../../utils/computers/local-consent.js";
import { consumeLocalNonce } from "../../utils/computers/local-terminal-auth.js";
import {
  findLocalBrowserSession,
  touchLocalBrowserSession,
} from "../../services/browserd/local/local-browser-session.js";
import type { ViewportFrame } from "../../services/browserd/daemon/viewport.js";

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_UNAVAILABLE = 4503;

/** Every open frame socket, so shutdown can close them. */
const liveSockets = new Set<{ close(): void }>();
let shuttingDown = false;
/**
 * Bumped by every sweep, latching or not.
 *
 * `shuttingDown` alone cannot answer "was this socket's setup overtaken?" for
 * the NON-latching kill Electron's `window-all-closed` runs: it does not latch,
 * so a socket still inside `subscribeFrames` when the sweep ran would register
 * itself afterwards and outlive the cleanup that was meant to take it.
 */
let killGeneration = 0;

/** Close every frame socket WITHOUT latching — Electron's window-all-closed. */
export function killLocalBrowserFrameSockets(): void {
  killGeneration += 1;
  for (const socket of liveSockets) {
    try {
      socket.close();
    } catch {
      // Already gone.
    }
  }
  liveSockets.clear();
}

/** Close every frame socket and refuse more. For a terminating process. */
export function shutdownLocalBrowserFrameSockets(): void {
  shuttingDown = true;
  killLocalBrowserFrameSockets();
}

/** Test seam: the latch is module state for the process lifetime. */
export function resetLocalBrowserFramesForTests(): void {
  shuttingDown = false;
  killGeneration = 0;
  liveSockets.clear();
}

export function createLocalBrowserFramesWsHandler(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (err: unknown) => void }
  >,
): MiddlewareHandler {
  return upgradeWebSocket(async (c) => {
    const protocolHeader = c.req.header("sec-websocket-protocol") ?? "";
    const nonce = protocolHeader.split(",")[0]?.trim() ?? "";
    const bootId = c.req.query("bootId") ?? "";
    const holder = c.req.query("holder") ?? undefined;
    const origin = c.req.header("Origin");

    // Everything resolvable before the socket opens is resolved here; a
    // failure becomes an immediate close-with-code in `onOpen`, because
    // `createEvents` cannot return an HTTP rejection once an upgrade has been
    // requested.
    let rejectCode: number | null = null;
    let rejectMessage = "";
    /**
     * The project the nonce was minted for.
     *
     * The socket names its target session by `bootId`, which the CLIENT
     * supplies — so redeeming a valid nonce is not on its own proof that this
     * caller may reach THIS browser. Without comparing the two, a nonce minted
     * for project A opens project B's browser, whose persistent profile is
     * signed in to whatever its owner signed in to. The check is in `onOpen`,
     * where the session is resolved.
     */
    let nonceProject: string | undefined;

    if (shuttingDown) {
      rejectCode = CLOSE_UNAVAILABLE;
      rejectMessage = "The inspector is shutting down.";
    } else if (!isAllowedRequestOrigin(origin)) {
      // An ABSENT Origin is rejected too: every legitimate caller here is the
      // inspector's own UI.
      rejectCode = CLOSE_UNAUTHORIZED;
      rejectMessage = "Frame requests must come from the inspector UI.";
    } else {
      const claim = consumeLocalNonce("browser-frames", nonce);
      if (!claim) {
        rejectCode = CLOSE_UNAUTHORIZED;
        rejectMessage = "Invalid or expired browser token.";
      } else if (
        claim.consentFingerprint !== (await getLocalConsentFingerprint())
      ) {
        rejectCode = CLOSE_UNAUTHORIZED;
        rejectMessage = "Local computer consent changed; reconnect.";
      } else {
        nonceProject = claim.projectId;
      }
    }

    // One socket's teardown state, shared by every exit path below. A close
    // can land WHILE `subscribeFrames` is still awaiting, in which case
    // `onClose` runs before `unsubscribe` exists — `closed` is what lets the
    // late setup undo itself instead of leaving a viewport listener attached
    // to a socket nobody is reading.
    let unsubscribe: (() => void) | undefined;
    let revalidate: (() => void) | undefined;
    let registered: { close(): void } | undefined;
    let closed = false;
    const detach = () => {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      revalidate = undefined;
      if (registered) {
        // Removed by IDENTITY, so a reconnect cannot retain the dead
        // `WSContext` of the connection it replaced: without this the set grows
        // by one closure per reconnect for the life of the process.
        liveSockets.delete(registered);
        registered = undefined;
      }
    };

    return {
      async onOpen(_event, ws: WSContext) {
        if (rejectCode !== null) {
          ws.close(rejectCode, rejectMessage);
          return;
        }
        if (shuttingDown) {
          ws.close(CLOSE_UNAVAILABLE, "The inspector is shutting down.");
          return;
        }
        const openedAt = killGeneration;
        const session = findLocalBrowserSession(bootId);
        if (!session) {
          ws.close(CLOSE_NOT_FOUND, "That browser is no longer running.");
          return;
        }
        // The nonce says which project this caller proved consent for; the
        // bootId says which browser they are asking to watch. They have to be
        // the same one.
        if (!nonceProject || session.projectKey !== nonceProject) {
          ws.close(CLOSE_UNAUTHORIZED, "That browser belongs to another project.");
          return;
        }

        const subscription = await session.handler.subscribeFrames({
          ...(holder ? { holder } : {}),
          onRevoked: (reason) => {
            // The lease moved to somebody else while this pane was watching.
            // Say so and close rather than going quiet: a frozen picture reads
            // as a broken stream, and the pane can offer "wait for them to
            // hand it back" only if it knows that is what happened.
            try {
              ws.close(CLOSE_UNAUTHORIZED, reason);
            } catch {
              // Already gone.
            }
            detach();
          },
          listener: (frame: ViewportFrame) => {
            // JSON rather than the binary header the WebMCP stream uses. This
            // socket is loopback on the user's own machine, where the base64
            // overhead costs a memcpy and buys one obvious wire format; the
            // hosted path, which crosses a real network, is where the packed
            // frame earns its complexity.
            try {
              ws.send(JSON.stringify({ type: "frame", frame }));
            } catch {
              // A socket that has gone away: the unsubscribe on close handles
              // the rest.
            }
          },
        });

        if (!subscription.ok) {
          // The lease is held by someone else. Not an error state to retry
          // into — the pane says who has it and waits.
          ws.close(CLOSE_UNAUTHORIZED, subscription.error);
          return;
        }
        // Every race the await above opens: the client hung up, a latching
        // shutdown began, or a NON-latching sweep ran (Electron closing its
        // last window) — the last of which `shuttingDown` cannot see, which is
        // what the generation is for. Registering now would leave this socket
        // attached after the cleanup that was meant to take it.
        if (closed || shuttingDown || killGeneration !== openedAt) {
          subscription.unsubscribe();
          if (!closed) ws.close(CLOSE_UNAVAILABLE, "closed");
          return;
        }
        unsubscribe = subscription.unsubscribe;
        revalidate = subscription.revalidate;
        registered = { close: () => ws.close(CLOSE_UNAVAILABLE, "closed") };
        liveSockets.add(registered);
        // Watching IS using it: a person with the pane open must not have the
        // browser reaped out from under them. Frames themselves never tick the
        // clock — a CSS spinner would keep a browser alive forever.
        touchLocalBrowserSession(session.handle);
      },
      onMessage(event, ws: WSContext) {
        // The only inbound message is a heartbeat, sent while the tab is
        // visible. It is what tells us somebody is still there.
        try {
          const parsed = JSON.parse(String(event.data)) as { type?: unknown };
          if (parsed?.type !== "ping") return;
          // The heartbeat is also when a watcher's right to watch is re-asked
          // out of band. Revocation otherwise rides frame delivery, and a
          // STATIC page delivers none — so a pane that lost the lease would
          // sit on a frozen picture, unable to tell that apart from a quiet
          // page.
          revalidate?.();
          if (closed) return;
          const session = findLocalBrowserSession(bootId);
          if (session) touchLocalBrowserSession(session.handle);
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          // Not our protocol; ignore rather than close.
        }
      },
      onClose() {
        detach();
      },
      onError(error: unknown) {
        logger.warn("[local-browser-frames] socket error", {
          error: error instanceof Error ? error.message : String(error),
        });
        detach();
      },
    };
  });
}
