/**
 * The hosted browser's frame socket (`/api/web/computers/browser/frames`).
 *
 * The last hop of the pair. `GET /v1/frames` on the daemon carries CDP
 * screencast frames out of the sandbox to this replica; this route carries them
 * on to a pane. It is the hosted twin of `local-browser-frames.ts`, which does
 * the same job for an in-process daemon by calling `subscribeFrames` directly.
 *
 * NOT A REPLACEMENT FOR `computer-browser-stream.ts`. That proxies RFB and
 * shows the whole DESKTOP — window manager, dialogs, popups — and remains the
 * right thing for "open the full desktop". This is the PAGE, at the daemon's
 * 1024×768 observation viewport, which is what belongs in a rail beside the
 * local and Electron panes.
 *
 * THE HOLDER IS THE VERIFIED USER, NEVER THE CLIENT. The daemon's
 * `watcherRefusal` lets a subscriber through when `holder === lease.holder`, so
 * a holder taken from the query string would let anyone who echoed the right id
 * watch somebody else's HELD session — a password field mid-typing. It comes
 * from the token's claims, exactly as `computer-browser-stream.ts` derives its
 * `viewerId`.
 *
 * WHY THE TWO HOPS SPEAK DIFFERENT LANGUAGES. Daemon → replica is the packed
 * binary format, because it crosses the sandbox boundary and carries every
 * frame. Replica → pane is the same JSON envelope the local pane already reads,
 * so one pane component can serve both engines (I-7) instead of two. The cost
 * is base64's third on this hop; switching it to the binary codec later is a
 * client-side change and nothing else.
 *
 * ONE UPSTREAM PER SOCKET, for now. Two panes on one session open two daemon
 * streams. That is fine at the daemon's cap of four and with no pane shipped
 * yet, but it is not free: `viewport.ts`'s byte-identical dedupe keys off a
 * `lastData` shared across subscribers, so a congested watcher can miss a
 * repaint the other received and stay stale. Fanning out from one upstream
 * stream fixes that and halves the box's egress; it is the right change the
 * moment a second pane per session is real.
 */
import type { MiddlewareHandler } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { verifyComputerBrowserToken } from "../../utils/computers/browser-token.js";
import {
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
  touchComputerActivity,
} from "../../utils/computers/control-plane-client.js";
import {
  lookupBrowserSession,
  touchBrowserSession,
  type BrowserSessionRecord,
} from "../../services/browserd/browser-sessions-client.js";
import { BrowserdClient } from "../../services/browserd/browserd-client.js";
import { browserdBundleHash } from "../../services/browserd/live-session-deps.js";
import { logger } from "../../utils/logger.js";

/**
 * The same ladder the local frame socket uses, and it matters that they match:
 * a pane branches on these to decide whether to retry.
 */
const CLOSE_UNAUTHORIZED = 4401; // terminal — do not retry
const CLOSE_NOT_FOUND = 4404; // no browser there
/**
 * Somebody else has the browser. TEMPORARY, and its own code for that reason:
 * a pane should hold its place and reconnect, not surface an error.
 */
const CLOSE_LEASE_HELD = 4409;
const CLOSE_UNAVAILABLE = 4503; // shutting down, or an unexplained drop

/** How often a watching pane keeps the session row and the box awake. */
const ACTIVITY_TOUCH_MS = 60_000;

export interface BrowserFramesDeps {
  verifyToken?: typeof verifyComputerBrowserToken;
  sandboxInfo?: typeof getComputerSandboxInfo;
  lookupSession?: typeof lookupBrowserSession;
  touchSession?: typeof touchBrowserSession;
  touchActivity?: typeof touchComputerActivity;
  bundleHash?: () => string;
  configured?: () => boolean;
  /** Open the daemon's frame stream. Injected so tests need no sandbox. */
  openUpstream?: (args: {
    session: BrowserSessionRecord;
    holder: string;
    tabId?: string;
    signal: AbortSignal;
    onFrame: (frame: {
      data: string;
      deviceWidth: number;
      deviceHeight: number;
      scale: number;
      ts: number;
      seq: number;
    }) => void;
    onEnd: (reason: string | undefined) => void;
  }) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}

const liveSockets = new Set<{ close(): void }>();
let shuttingDown = false;
/**
 * Bumped by a non-latching kill so a socket still inside its own `await` can
 * tell it was swept, which `shuttingDown` alone cannot express.
 */
let killGeneration = 0;

export function killBrowserFrameSockets(): void {
  killGeneration += 1;
  for (const socket of [...liveSockets]) {
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }
  liveSockets.clear();
}

export function shutdownBrowserFrameSockets(): void {
  shuttingDown = true;
  killBrowserFrameSockets();
}

export function resetBrowserFramesForTests(): void {
  shuttingDown = false;
  killGeneration = 0;
  liveSockets.clear();
}

export function createComputerBrowserFramesWsHandler(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (err: unknown) => void }
  >,
  deps: BrowserFramesDeps = {},
): MiddlewareHandler {
  const verifyToken = deps.verifyToken ?? verifyComputerBrowserToken;
  const sandboxInfo = deps.sandboxInfo ?? getComputerSandboxInfo;
  const lookupSession = deps.lookupSession ?? lookupBrowserSession;
  const touchSession = deps.touchSession ?? touchBrowserSession;
  const touchActivity = deps.touchActivity ?? touchComputerActivity;
  const bundleHash = deps.bundleHash ?? browserdBundleHash;
  const configured = deps.configured ?? isComputersDataPlaneConfigured;
  const openUpstream =
    deps.openUpstream ??
    (async (args) =>
      new BrowserdClient({
        baseUrl: args.session.publicOrigin,
        bearer: args.session.browserdToken,
      }).streamFrames({
        holder: args.holder,
        ...(args.tabId ? { tabId: args.tabId } : {}),
        signal: args.signal,
        onFrame: (frame) =>
          args.onFrame({
            // The pane reads base64, as the local one does.
            data: Buffer.from(frame.jpeg).toString("base64"),
            deviceWidth: frame.deviceWidth,
            deviceHeight: frame.deviceHeight,
            scale: frame.scale,
            ts: frame.ts,
            seq: frame.seq,
          }),
        onEnd: args.onEnd,
      }));

  return upgradeWebSocket(async (c) => {
    // The token rides `Sec-WebSocket-Protocol`: a browser cannot set a header
    // on a handshake, and a query string lands in proxy access logs.
    const protocolHeader = c.req.header("sec-websocket-protocol") ?? "";
    const token = protocolHeader.split(",")[0]?.trim() ?? "";
    const tabId = c.req.query("tabId") ?? undefined;

    // Resolved BEFORE the upgrade wherever possible, but reported as a close
    // code: once an upgrade has been requested there is no HTTP status left to
    // send. `createEvents` cannot reject.
    let refusal: { code: number; reason: string } | null = null;
    let session: BrowserSessionRecord | null = null;
    let viewerId = "";
    const openedAt = killGeneration;

    if (shuttingDown) {
      refusal = { code: CLOSE_UNAVAILABLE, reason: "shutting down" };
    } else if (!configured()) {
      refusal = { code: CLOSE_UNAVAILABLE, reason: "computers unconfigured" };
    } else {
      const claims = await verifyToken(token);
      if (!claims) {
        refusal = { code: CLOSE_UNAUTHORIZED, reason: "invalid token" };
      } else {
        const info = await sandboxInfo({ computerId: claims.computerId });
        if (!info.ok) {
          refusal = { code: CLOSE_UNAVAILABLE, reason: "computer unavailable" };
        } else if (
          // The mint authorized this about a minute ago and ownership can move
          // inside that window; the panel route re-checks for the same reason.
          info.value.ownerUserId !== claims.userId ||
          info.value.projectId !== claims.projectId
        ) {
          refusal = { code: CLOSE_UNAUTHORIZED, reason: "invalid token" };
        } else {
          viewerId = claims.userId;
          const lookup = await lookupSession({
            computerId: claims.computerId,
            expectedBundleHash: bundleHash(),
            // `"any"`: a pane watches whatever browser this computer is
            // running, which is the same question the panel's own lookup asks.
            expectedContextMode: "any",
          });
          session = lookup.session;
          if (!session) {
            refusal = { code: CLOSE_NOT_FOUND, reason: "no_browser_session" };
          }
        }
      }
    }

    // One socket's teardown state, shared by every exit path. A close can land
    // WHILE the upstream is still connecting, in which case `onClose` runs
    // before there is anything to tear down — `closed` is what lets the late
    // setup undo itself rather than leaving a daemon stream with no reader.
    const abort = new AbortController();
    let registered: { close(): void } | undefined;
    let activityTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const detach = () => {
      if (closed) return;
      closed = true;
      // Hangs up the daemon stream, which unsubscribes its viewport and lets
      // the screencast stop.
      abort.abort();
      if (activityTimer) clearInterval(activityTimer);
      activityTimer = undefined;
      if (registered) {
        // By identity, so a reconnect cannot retain the dead `WSContext` of the
        // connection it replaced.
        liveSockets.delete(registered);
        registered = undefined;
      }
    };

    return {
      async onOpen(_event: Event, ws: WSContext) {
        if (refusal || !session) {
          ws.close(
            refusal?.code ?? CLOSE_UNAVAILABLE,
            refusal?.reason ?? "unavailable",
          );
          return;
        }
        const live = session;

        registered = { close: () => ws.close(CLOSE_UNAVAILABLE, "closed") };
        liveSockets.add(registered);

        /**
         * A watching pane issues no COMMANDS, so nothing else keeps the session
         * row fresh or the box awake — and the idle sweep would reap a browser
         * somebody is looking at.
         */
        const touch = () => {
          void touchSession({ sessionId: live.sessionId, kind: "panel" }).catch(
            () => {},
          );
          void touchActivity({ computerId: live.computerId }).catch(() => {});
        };
        touch();
        activityTimer = setInterval(touch, ACTIVITY_TOUCH_MS);

        const started = await openUpstream({
          session: live,
          // NEVER from the client: see the module docstring.
          holder: viewerId,
          ...(tabId ? { tabId } : {}),
          signal: abort.signal,
          onFrame: (frame) => {
            if (closed) return;
            try {
              ws.send(JSON.stringify({ type: "frame", frame }));
            } catch {
              /* the socket went away between the check and the send */
            }
          },
          onEnd: (reason) => {
            if (closed) return;
            const [code, text] = closeFor(reason);
            detach();
            try {
              ws.close(code, text);
            } catch {
              /* already gone */
            }
          },
        }).catch((error: unknown) => ({
          ok: false as const,
          status: 0,
          error: error instanceof Error ? error.message : String(error),
        }));

        if (!started.ok) {
          detach();
          logger.warn("[computers] browser frame stream refused", {
            computerId: live.computerId,
            status: started.status,
          });
          ws.close(
            started.status === 404 ? CLOSE_NOT_FOUND : CLOSE_UNAVAILABLE,
            "upstream refused",
          );
          return;
        }
        if (closed || shuttingDown || killGeneration !== openedAt) {
          // Swept, or hung up on, while the upstream was connecting.
          detach();
          ws.close(CLOSE_UNAVAILABLE, "closed");
        }
      },
      onMessage(event: MessageEvent, ws: WSContext) {
        // The only inbound message is the pane's heartbeat. Unlike the local
        // socket's, it does not need to re-ask the lease — the DAEMON does that
        // on its own tick now, because a one-way stream has no ping to borrow.
        // It still says somebody is watching.
        try {
          const parsed = JSON.parse(String(event.data)) as { type?: unknown };
          if (parsed?.type !== "ping" || closed) return;
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          // Not our protocol; ignore rather than close.
        }
      },
      onClose() {
        detach();
      },
      onError(error: unknown) {
        logger.warn("[computers] browser frame socket error", {
          error: error instanceof Error ? error.message : String(error),
        });
        detach();
      },
    };
  });
}

/**
 * Turn the daemon's terminal reason into a close code.
 *
 * The distinction the daemon's `end` record exists to carry: a lease refusal is
 * TEMPORARY and the pane should come back, while a missing tab or an
 * unexplained drop are different situations again. `undefined` means the stream
 * stopped without saying — treated as retryable, because a drop usually is.
 */
function closeFor(reason: string | undefined): [number, string] {
  switch (reason) {
    case "lease_held":
    case "lease_parked":
      return [CLOSE_LEASE_HELD, reason];
    case "unknown_tab":
    case "tab_gone":
      return [CLOSE_NOT_FOUND, reason];
    case "shutting_down":
      return [CLOSE_UNAVAILABLE, reason];
    default:
      return [CLOSE_UNAVAILABLE, "stream ended"];
  }
}
