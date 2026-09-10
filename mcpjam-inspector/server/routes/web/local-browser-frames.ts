import { createBrowserConsentLifetime } from "../../services/browserd/local/consent-lifetime.js";
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
import { getBrowserConsentFingerprint } from "../../utils/computers/browser-consent.js";
import { consumeLocalNonce } from "../../utils/computers/local-terminal-auth.js";
import {
  findLocalBrowserSession,
  touchLocalBrowserSession,
} from "../../services/browserd/local/local-browser-session.js";
import type { ViewportFrame } from "../../services/browserd/daemon/viewport.js";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
} from "../../services/browserd/frame-stream.js";
import { createFrameRelayStats, pongFor } from "./browser-frame-relay-stats.js";
import {
  createRelayInputForwarder,
  type RelayInputForwarder,
} from "./browser-pane-input-forwarder.js";
import { parseBrowserPaneInputMessage } from "../../../shared/browser-pane-input.js";
import type { ViewportInputEvent } from "../../services/browserd/daemon/viewport.js";

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_NOT_FOUND = 4404;
/**
 * Somebody else holds the browser.
 *
 * Its OWN code, distinct from `CLOSE_UNAUTHORIZED`, because the two mean
 * opposite things to the pane. An auth failure is terminal — the nonce is
 * spent, the consent fingerprint moved — and retrying only burns credentials.
 * A lease refusal is temporary by definition: the holder will hand back, and
 * the pane that keeps its place is the one that comes alive again when they
 * do. Sharing one code forced a single response on both, and the pane picked
 * the wrong one — a consent change was reported as "somebody took control",
 * and a watcher who lost the race stayed dark forever after, because nothing
 * reconnected.
 */
const CLOSE_LEASE_HELD = 4409;
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
    const tabId = c.req.query("tabId") || undefined;
    const holder = c.req.query("holder") ?? undefined;
    /**
     * The daemon's own bytes instead of a JSON envelope.
     *
     * Worth doing even on loopback, where base64 costs a memcpy rather than a
     * network hop: the point is that ONE pane component reads one wire on both
     * engines, so the hosted path's decoder is exercised on every local run
     * rather than only on staging.
     */
    const binaryWire = c.req.query("wire") === "binary";
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
    let fingerprint: string | undefined;
    let lifetime:
      | Awaited<ReturnType<typeof createBrowserConsentLifetime>>
      | undefined;

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
        claim.consentFingerprint !== (await getBrowserConsentFingerprint())
      ) {
        rejectCode = CLOSE_UNAUTHORIZED;
        rejectMessage = "Local computer consent changed; reconnect.";
      } else {
        nonceProject = claim.projectId;
        fingerprint = claim.consentFingerprint;
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
    /** Per socket, so one congested pane's loss is not averaged away. */
    let stats: ReturnType<typeof createFrameRelayStats> | undefined;
    /** One dispatch at a time, so a drag arrives in the order it was made. */
    let input: RelayInputForwarder | undefined;
    let closed = false;
    /** Timers and the like this socket started, torn down with it. */
    const cleanups: Array<() => void> = [];
    const detach = () => {
      closed = true;
      lifetime?.dispose();
      for (const stop of cleanups.splice(0)) {
        try {
          stop();
        } catch {
          // A timer already cleared.
        }
      }
      unsubscribe?.();
      unsubscribe = undefined;
      revalidate = undefined;
      stats?.stop();
      stats = undefined;
      // Whatever is queued belonged to the hold that queued it.
      input?.cancel();
      input = undefined;
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
        try {
          lifetime = await createBrowserConsentLifetime(
            fingerprint,
            getBrowserConsentFingerprint,
          );
          lifetime.onRevoked(() => {
            ws.close(CLOSE_UNAUTHORIZED, "Browser permission changed.");
            detach();
          });
        } catch {
          ws.close(CLOSE_UNAUTHORIZED, "Browser permission changed.");
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
          ws.close(
            CLOSE_UNAUTHORIZED,
            "That browser belongs to another project.",
          );
          return;
        }

        const subscription = await session.handler.subscribeFrames({
          tabId,
          ...(holder ? { holder } : {}),
          onRevoked: (reason) => {
            // The lease moved to somebody else while this pane was watching.
            // Say so and close rather than going quiet: a frozen picture reads
            // as a broken stream, and the pane can offer "wait for them to
            // hand it back" only if it knows that is what happened.
            try {
              ws.close(CLOSE_LEASE_HELD, reason);
            } catch {
              // Already gone.
            }
            detach();
          },
          listener: async (frame: ViewportFrame) => {
            try {
              await lifetime?.assertActive();
            } catch {
              return;
            }
            // JSON rather than the binary header the WebMCP stream uses. This
            // socket is loopback on the user's own machine, where the base64
            // overhead costs a memcpy and buys one obvious wire format; the
            // hosted path, which crosses a real network, is where the packed
            // frame earns its complexity.
            if (closed) {
              stats?.countDrop();
              return;
            }
            if (binaryWire) {
              // The same 24-byte header the hosted daemon writes, so the pane
              // has one decoder. The comment this replaces anticipated exactly
              // this change.
              const bytes = new Uint8Array(
                encodeFrameStreamRecord({
                  kind: FRAME_STREAM_KIND.frame,
                  deviceWidth: frame.deviceWidth,
                  deviceHeight: frame.deviceHeight,
                  scale: frame.scale,
                  ts: Date.now(),
                  seq: frame.seq,
                  jpeg: new Uint8Array(Buffer.from(frame.data, "base64")),
                }),
              );
              stats?.offer(bytes.byteLength, () => {
                if (!closed && lifetime?.isActive()) ws.send(bytes);
              });
              return;
            }
            // `relayTs` even on loopback, where it equals `ts` to within a
            // millisecond. The pane must not have to know which engine drew a
            // frame to know which field it may subtract from its own clock.
            const stamped = { ...frame, relayTs: Date.now() };
            const payload = JSON.stringify({ type: "frame", frame: stamped });
            stats?.offer(payload.length, () => {
              if (!closed && lifetime?.isActive()) ws.send(payload);
            });
          },
        });

        if (!subscription.ok) {
          // Somebody else holds the browser, or the tab named does not exist.
          // Neither is an auth failure, and the first resolves on its own —
          // the pane reconnects and picks the picture back up when the holder
          // hands it back.
          ws.close(
            subscription.error === "unknown_tab"
              ? CLOSE_NOT_FOUND
              : CLOSE_LEASE_HELD,
            subscription.error,
          );
          return;
        }
        // Every race the await above opens: the client hung up, a latching
        // shutdown began, or a NON-latching sweep ran (Electron closing its
        // last window) — the last of which `shuttingDown` cannot see, which is
        // what the generation is for. Registering now would leave this socket
        // attached after the cleanup that was meant to take it.
        try {
          await lifetime?.assertActive();
        } catch {
          subscription.unsubscribe();
          detach();
          return;
        }
        if (closed || shuttingDown || killGeneration !== openedAt) {
          subscription.unsubscribe();
          if (!closed) ws.close(CLOSE_UNAVAILABLE, "closed");
          return;
        }
        unsubscribe = subscription.unsubscribe;
        revalidate = subscription.revalidate;
        registered = { close: () => ws.close(CLOSE_UNAVAILABLE, "closed") };
        liveSockets.add(registered);
        stats = createFrameRelayStats({
          send: (payload) => ws.send(payload),
          bufferedAmount: () =>
            (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount,
        });
        stats.setSubscribers(1);
        stats.start();
        // THE VIEWPORT'S OWN LOSS, on the same message. The hosted pane gets
        // it because the daemon sends it in the heartbeat across the sandbox
        // boundary; in-process there is no heartbeat to ride, so without this
        // the local overlay silently reported no dedupe, oversize or pacer
        // drops at all — the one engine a developer debugs against.
        const mergeViewport = () => {
          if (closed || !subscription.ok) return;
          try {
            const counters = subscription.counters();
            // The page-tool change signal, synthesized for the same reason the
            // drop counters are: in-process there is no heartbeat to ride, so
            // without this the Tools pane would be live on the hosted engine
            // and permanently stale on the one a developer debugs against.
            const webmcp = session.handler.webmcpSnapshot?.();
            stats?.mergeDaemon({
              framesIn: counters.framesIn,
              framesOut: counters.framesOut,
              bytesOut: counters.bytesOut,
              dropped: counters.dropped,
              ...(webmcp
                ? {
                    webmcp: {
                      revision: webmcp.revision,
                      hash: webmcp.hash,
                      count: webmcp.count,
                      ...(webmcp.url ? { url: webmcp.url } : {}),
                    },
                  }
                : {}),
            });
          } catch {
            // Telemetry. A subscription that cannot answer is not a reason to
            // take down a pane that is watching perfectly well.
          }
        };
        mergeViewport();
        const viewportCounters = setInterval(mergeViewport, 1_000);
        cleanups.push(() => clearInterval(viewportCounters));

        input = createRelayInputForwarder({
          dispatch: async ({ tabId, events }) => {
            try {
              await lifetime?.assertActive();
            } catch {
              return { ok: false, refused: "no_browser_session" };
            }
            if (closed)
              return { ok: false, refused: "no_browser_session" };
            // Resolved per batch rather than captured: the browser can be
            // relaunched under a live pane, and the handle this socket opened
            // with would then dispatch into a session that is gone.
            const current = findLocalBrowserSession(bootId);
            if (!current) return { ok: false, refused: "no_browser_session" };
            const result = await current.handler.dispatchInput({
              // From the SOCKET's query, mirroring `POST /local-browser/input`.
              // The nonce proved consent for this project; the holder only has
              // to tell one pane from another so two tabs cannot each believe
              // they have control.
              ...(holder ? { holder } : { holder: "" }),
              ...(tabId ? { tabId } : {}),
              events: events as readonly ViewportInputEvent[],
            });
            if (result.ok) {
              touchLocalBrowserSession(current.handle);
              return { ok: true };
            }
            return {
              ok: false,
              refused:
                result.error === "unknown_tab" ? "unknown_tab" : "lease_held",
            };
          },
          ack: (payload) => {
            if (closed) return;
            try {
              ws.send(JSON.stringify({ type: "input_ack", ...payload }));
            } catch {
              // Already gone.
            }
          },
        });

        // What this server can do, said before the pane has to guess. A client
        // that does not see `input` here keeps POSTing.
        try {
          ws.send(
            JSON.stringify({
              type: "hello",
              features: ["input"],
              codecs: ["jpeg"],
              wire: binaryWire ? "binary" : "json",
            }),
          );
        } catch {
          // Already gone.
        }
        // Watching IS using it: a person with the pane open must not have the
        // browser reaped out from under them. Frames themselves never tick the
        // clock — a CSS spinner would keep a browser alive forever.
        touchLocalBrowserSession(session.handle);
      },
      async onMessage(event, ws: WSContext) {
        try {
          await lifetime?.assertActive();
        } catch {
          return;
        }
        // The only inbound message is a heartbeat, sent while the tab is
        // visible. It is what tells us somebody is still there.
        try {
          const parsed = JSON.parse(String(event.data)) as {
            type?: unknown;
            t?: unknown;
          };
          if (closed) return;
          if (parsed?.type === "input") {
            const message = parseBrowserPaneInputMessage(parsed);
            if (!message.ok) {
              const seq = (parsed as { seq?: unknown }).seq;
              ws.send(
                JSON.stringify({
                  type: "input_ack",
                  seq: typeof seq === "number" ? seq : -1,
                  dispatched: 0,
                  refused: "invalid_input",
                }),
              );
              return;
            }
            input?.submit(message);
            return;
          }
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
          ws.send(pongFor(parsed));
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
