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
import { shouldTouchActivity } from "../../utils/computers/activity-touch.js";
import {
  lookupBrowserSession,
  touchBrowserSession,
  type BrowserSessionRecord,
} from "../../services/browserd/browser-sessions-client.js";
import { BrowserdClient } from "../../services/browserd/browserd-client.js";
import type { ViewportInputEvent } from "../../services/browserd/daemon/viewport.js";
import { browserdBundleHash } from "../../services/browserd/live-session-deps.js";
import {
  createFrameRelayStats,
  pongFor,
  type DaemonFrameCounters,
} from "./browser-frame-relay-stats.js";
import {
  createRelayInputForwarder,
  type InputRefusal,
  type RelayInputForwarder,
} from "./browser-pane-input-forwarder.js";
import { parseBrowserPaneInputMessage } from "../../../shared/browser-pane-input.js";
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

/**
 * How often a WATCHED pane keeps the session row and the box awake.
 *
 * Watched, not merely connected: the touch on each tick needs a ping since the
 * last one. See the timer below.
 */
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
    /** The daemon's own counters, from the heartbeat. */
    onStats?: (stats: DaemonFrameCounters) => void;
    onEnd: (reason: string | undefined) => void;
  }) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /**
   * Forward one batch to the daemon. Injected so tests need no sandbox, and
   * separate from `openUpstream` because input and frames now share a socket
   * but still take opposite hops.
   */
  sendInput?: (args: {
    session: BrowserSessionRecord;
    holder: string;
    tabId?: string;
    events: readonly ViewportInputEvent[];
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
        ...(args.onStats
          ? { onStats: (stats) => args.onStats?.(stats) }
          : {}),
        onEnd: args.onEnd,
      }));
  const sendInput =
    deps.sendInput ??
    (async (args) =>
      new BrowserdClient({
        baseUrl: args.session.publicOrigin,
        bearer: args.session.browserdToken,
      }).sendInput({
        holder: args.holder,
        events: args.events,
        ...(args.tabId ? { tabId: args.tabId } : {}),
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
    /**
     * What this socket saw, and what it could not pass on.
     *
     * Created per socket rather than per route: the interesting number is one
     * pane's loss, and a process-wide counter would average a congested viewer
     * away against every healthy one.
     */
    let stats: ReturnType<typeof createFrameRelayStats> | undefined;
    /** One dispatch in flight per socket — see the forwarder's docstring. */
    let input: RelayInputForwarder | undefined;
    /**
     * Has the pane said it is being looked at since the last activity touch?
     *
     * Reset by each touch and set by each ping, so a pane that goes quiet stops
     * deferring the idle sweep within one interval.
     */
    let watched = false;
    let closed = false;
    const detach = () => {
      if (closed) return;
      closed = true;
      // Hangs up the daemon stream, which unsubscribes its viewport and lets
      // the screencast stop.
      abort.abort();
      if (activityTimer) clearInterval(activityTimer);
      activityTimer = undefined;
      stats?.stop();
      stats = undefined;
      // Whatever is queued belonged to the hold that queued it; delivering it
      // after the socket went away types into whoever holds the browser next.
      input?.cancel();
      input = undefined;
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

        stats = createFrameRelayStats({
          send: (payload) => ws.send(payload),
          bufferedAmount: () =>
            (ws.raw as { bufferedAmount?: number } | undefined)?.bufferedAmount,
        });
        stats.setSubscribers(1);
        stats.start();

        input = createRelayInputForwarder({
          dispatch: async ({ tabId, events }) => {
            const outcome = await sendInput({
              session: live,
              // NEVER from the client, exactly as `POST /input` derives it: the
              // daemon admits input when `holder === lease.holder`, so a holder
              // read off the wire would let anyone who echoed the right id type
              // into somebody else's held session — a password field, mid-login.
              holder: viewerId,
              ...(tabId ? { tabId } : {}),
              events: events as readonly ViewportInputEvent[],
            });
            if (outcome.ok) return { ok: true };
            return { ok: false, refused: refusalFor(outcome.status) };
          },
          ack: (payload) => {
            if (closed) return;
            try {
              ws.send(JSON.stringify({ type: "input_ack", ...payload }));
            } catch {
              /* the socket went away */
            }
          },
          onDispatched: () => {
            // A person typing is REAL USE, and `kind: "command"` says so: the
            // panel keepalive stops counting once the last real command is old
            // enough, which is exactly the case for somebody who took control
            // to solve a CAPTCHA and issues no agent commands at all.
            //
            // Throttled through the shared per-computer window — input arrives
            // twenty times a second and a touch is a control-plane write — and
            // only on a dispatch that actually landed.
            if (closed) return;
            if (!shouldTouchActivity(live.computerId)) return;
            void touchSession({
              sessionId: live.sessionId,
              kind: "command",
            }).catch(() => {});
            void touchActivity({ computerId: live.computerId }).catch(() => {});
          },
        });

        // What this server can do, said before the pane has to guess. A client
        // that does not see `input` here keeps POSTing, which is how a new
        // build talks to an old server for one release.
        try {
          ws.send(
            JSON.stringify({
              type: "hello",
              features: ["input"],
              codecs: ["jpeg"],
            }),
          );
        } catch {
          /* the socket went away between the upgrade and the first send */
        }

        /**
         * A watching pane issues no COMMANDS, so nothing else keeps the session
         * row fresh or the box awake — and the idle sweep would reap a browser
         * somebody is looking at.
         */
        const touch = () => {
          watched = false;
          // THE BACKEND HAS THE LAST WORD, exactly as `/keepalive` lets it.
          // `touchSession` answers `counted: false` once the browser has gone
          // long enough without a real command, which is the ceiling that
          // stops a pane left open over a weekend holding a metered box awake
          // forever. Firing `touchActivity` regardless discarded that answer
          // and bumped `lastActiveAt` anyway, so the idle sweep never came —
          // the same class of bug as the connected-but-unwatched socket this
          // route just fixed, one layer further in. Watching is evidence
          // somebody is there; it is not evidence the machine is still doing
          // anything worth paying for.
          void touchSession({ sessionId: live.sessionId, kind: "panel" })
            .then(({ counted }) => {
              // `closed` FIRST: this continuation can land after the pane hung
              // up, and touching then keeps a computer awake for a socket that
              // is gone.
              if (closed || !counted) return;
              if (!shouldTouchActivity(live.computerId)) return;
              void touchActivity({ computerId: live.computerId }).catch(
                () => {},
              );
            })
            .catch(() => {});
        };
        // Opening one counts: somebody just asked for it.
        touch();
        activityTimer = setInterval(() => {
          // AN OPEN SOCKET IS NOT SOMEBODY WATCHING. The pane stays connected
          // behind the rail's other tabs — dropping it would stop the
          // screencast and make the browser go dark on every glance — and it
          // stays connected in a background browser tab too. It stops PINGING
          // in both cases, which is the only evidence anybody is looking.
          //
          // Without this a pane left open behind the Logs tab holds a metered
          // cloud box awake indefinitely, which the local socket never does
          // and which the person pays for.
          if (!watched) return;
          touch();
        }, ACTIVITY_TOUCH_MS);

        const started = await openUpstream({
          session: live,
          // NEVER from the client: see the module docstring.
          holder: viewerId,
          ...(tabId ? { tabId } : {}),
          signal: abort.signal,
          onFrame: (frame) => {
            if (closed) {
              stats?.countDrop();
              return;
            }
            // `relayTs` and not the sandbox's `ts`: the two clocks belong to
            // different machines, so a pane subtracting `ts` from `Date.now()`
            // reports the drift between two boxes and calls it latency. This
            // one is stamped by the hop the pane can actually compare against
            // — it measured this replica's round trip with its own ping.
            const stamped = { ...frame, relayTs: Date.now() };
            const payload = JSON.stringify({ type: "frame", frame: stamped });
            stats?.offer(payload.length, () => ws.send(payload));
          },
          // The daemon's side of the accounting, merged into the same `stats`
          // message the relay's own counters go out on. One shape for the pane,
          // whichever engine it is looking at.
          onStats: (daemon) => {
            stats?.mergeDaemon(daemon);
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
          const parsed = JSON.parse(String(event.data)) as {
            type?: unknown;
            t?: unknown;
          };
          if (closed) return;
          if (parsed?.type === "input") {
            const message = parseBrowserPaneInputMessage(parsed);
            if (!message.ok) {
              // An ack, not a close: a malformed batch is a bug in one
              // message, and dropping the socket would take the picture with
              // it.
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
          // The evidence the activity timer waits for.
          watched = true;
          // The pane's own stamp comes back untouched, which is what makes the
          // round trip measurable at all: nothing here reads it, because this
          // clock is not the pane's.
          ws.send(pongFor(parsed));
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
 * Turn the daemon's input status into the ack's `refused` word.
 *
 * A 423 is the ORDINARY answer while the agent is driving, not a failure —
 * which is exactly why it must not become a close. Everything else the daemon
 * can answer (a stale bearer, a 500, an origin refusal) is an upstream
 * problem, and dressing one up as a lease refusal would tell the pane to wait
 * for a hand-back from a holder who does not exist.
 */
function refusalFor(status: number): InputRefusal {
  if (status === 423) return "lease_held";
  if (status === 404) return "unknown_tab";
  if (status === 409) return "no_browser_session";
  return "upstream_error";
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
