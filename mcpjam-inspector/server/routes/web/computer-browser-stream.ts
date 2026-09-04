/**
 * The Browser panel's video feed, proxied so the desktop's password never
 * reaches the browser.
 *
 * Before this, the panel embedded E2B's own noVNC page and put the stream
 * password in the iframe's query string. That password is not a view
 * credential — the daemon's handoff lease gates model-driven commands, not VNC
 * input, and `view_only` is a flag the client sets on itself — so anyone who
 * read it out of the DOM had full keyboard and mouse on the member's desktop
 * for as long as the stream lived. It was in the URL, so it was also in
 * `document.referrer`, in browser history, and in any logging that records
 * iframe sources.
 *
 * So the inspector speaks RFB itself. It authenticates upstream with the
 * password from the session row, offers the browser security type `None` on a
 * socket the panel's own short-lived token already authenticated, and pipes
 * bytes between them. The credential stays on the replica.
 *
 * Proxying is also what makes the lease REAL for a human viewer. The daemon
 * cannot enforce it over VNC — it never sees those packets — so the filter in
 * `rfb-client-filter.ts` runs here, on every client→server message, and drops
 * anything that reaches the desktop's input queue unless this viewer currently
 * holds the lease. A viewer who strips `view_only`, or who points a raw RFB
 * client at this socket with a valid token, gets a picture and nothing else.
 *
 * VALIDATE-ON-STAGING: the upstream URL shape (`wss://<host:6080>/websockify`)
 * comes from `@e2b/desktop`'s own recipe — `novnc_proxy --vnc localhost:5900
 * --listen 6080 --web /opt/noVNC` in front of `x11vnc -rfbauth ... -shared` —
 * but has not been exercised against a live sandbox. The handshake it performs
 * is unit-tested against the protocol in `utils/computers/rfb-handshake.ts`.
 */
import type { MiddlewareHandler } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import WebSocket from "ws";
import { verifyComputerBrowserToken } from "../../utils/computers/browser-token.js";
import {
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
} from "../../utils/computers/control-plane-client.js";
import {
  lookupBrowserSession,
  type BrowserSessionRecord,
} from "../../services/browserd/browser-sessions-client.js";
import { BrowserdClient } from "../../services/browserd/browserd-client.js";
import { browserdBundleHash } from "../../services/browserd/live-session-deps.js";
import { RfbClientFilter } from "../../utils/computers/rfb-client-filter.js";
import {
  clientInit,
  parseProtocolVersion,
  parseSecurityResult,
  parseSecurityTypes,
  securityResultOk,
  securityTypesOffer,
  vncAuthResponse,
  RFB_PROTOCOL_VERSION_3_8,
  RFB_SECURITY,
} from "../../utils/computers/rfb-handshake.js";
import { logger } from "../../utils/logger.js";

/** Same ladder the frame socket uses: 4401 stop trying, 4404 gone, 4503 later. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GONE = 4404;
const CLOSE_UNAVAILABLE = 4503;

/** How long the upstream handshake may take before we give up on it. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * How long a lease reading is trusted before it is re-fetched.
 *
 * Short, because it decides whether keystrokes reach a desktop: a viewer who
 * hands the lease back keeps typing for at most this long. Not zero, because
 * the alternative is a control-plane round trip per mouse-move.
 */
const LEASE_CACHE_MS = 2_000;
/**
 * ProtocolVersion (12) + the chosen security type (1) + ClientInit (1). Fixed,
 * because we dictate the browser's handshake: one security type, `None`, so
 * there is no challenge round in between.
 */
const CLIENT_HANDSHAKE_BYTES = 14;

export interface BrowserStreamDeps {
  verifyToken?: typeof verifyComputerBrowserToken;
  sandboxInfo?: typeof getComputerSandboxInfo;
  lookupSession?: typeof lookupBrowserSession;
  configured?: () => boolean;
  bundleHash?: () => string;
  /** Opens the upstream socket; injected so tests need no sandbox. */
  connectUpstream?: (session: BrowserSessionRecord) => UpstreamSocket;
  /** Reads the daemon's handoff lease holder, or null when nobody holds it. */
  leaseHolder?: (session: BrowserSessionRecord) => Promise<string | null>;
}

/** The upstream half, narrowed so a test can supply a pair of fakes. */
export interface UpstreamSocket {
  send(data: Uint8Array): void;
  close(): void;
  onMessage(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  onOpen(handler: () => void): void;
}

/**
 * The desktop's noVNC endpoint, derived from the daemon's own origin.
 *
 * E2B's `getHost(port)` returns `<port>-<sandboxId>.<domain>`, so the daemon's
 * origin already names a port in its hostname and the stream is the same
 * sandbox at 6080. Rewriting it is the whole derivation.
 *
 * THROWS rather than falling through when the shape is not what it expects.
 * Left as a silent `replace` that matched nothing, an unfamiliar host — a
 * changed E2B scheme, or the SDK's own `localhost:<port>` debug form — dialled
 * the DAEMON's port instead, where the RFB handshake would hang against an
 * HTTP server until the timeout. A named failure is a bug report; that was a
 * mystery.
 */
export function noVncWebSocketUrl(publicOrigin: string): string {
  const origin = new URL(publicOrigin);
  // The SDK's debug mode returns `localhost:<port>`, where the port is a real
  // URL port rather than part of the hostname.
  if (origin.port) return `wss://${origin.hostname}:6080/websockify`;
  if (!/^\d+-/.test(origin.hostname)) {
    throw new Error(
      `cannot derive the noVNC endpoint from "${publicOrigin}": expected a ` +
        `"<port>-<sandbox>" host or an explicit port`,
    );
  }
  return `wss://${origin.hostname.replace(/^\d+-/, "6080-")}/websockify`;
}

function wsUpstream(session: BrowserSessionRecord): UpstreamSocket {
  const socket = new WebSocket(noVncWebSocketUrl(session.publicOrigin), [
    "binary",
  ]);
  socket.binaryType = "nodebuffer";
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onMessage: (handler) =>
      socket.on("message", (data) => handler(new Uint8Array(data as Buffer))),
    onClose: (handler) => socket.on("close", handler),
    onError: (handler) => socket.on("error", handler),
    onOpen: (handler) => socket.on("open", handler),
  };
}

/**
 * Drives the RFB handshake with the upstream server, then reports that the
 * connection is ready to carry messages.
 *
 * A small state machine rather than a sequence of awaits, because the bytes
 * arrive as a stream: each stage consumes exactly what it needs and leaves the
 * rest for the next one, and the final stage hands the remainder — which is
 * already the beginning of the server's first message — to the caller.
 */
class UpstreamHandshake {
  private stage:
    | "version"
    | "security-types"
    | "vnc-challenge"
    | "security-result"
    | "done" = "version";
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly password: string,
    private readonly send: (data: Uint8Array) => void,
    private readonly onReady: (leftover: Uint8Array) => void,
    private readonly onFailed: (reason: string) => void,
  ) {}

  get finished(): boolean {
    return this.stage === "done";
  }

  push(chunk: Uint8Array): void {
    if (this.stage === "done") return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    // Each stage consumes exactly what it needs, so several can complete from
    // one chunk — the server is free to send its whole handshake at once.
    while (this.step()) {
      /* advanced a stage; try the next one against what is left */
    }
  }

  /** One stage; false when it needs more bytes. */
  private step(): boolean {
    switch (this.stage) {
      case "version": {
        const version = parseProtocolVersion(this.buffer);
        if (version === null) {
          if (this.buffer.length >= 12) {
            this.onFailed("upstream did not speak RFB");
            this.stage = "done";
          }
          return false;
        }
        this.buffer = this.buffer.subarray(12);
        // We answer 3.8 regardless of what the server offered: it is the only
        // version this proxy implements, and every server that speaks a later
        // one accepts it.
        this.send(Buffer.from(RFB_PROTOCOL_VERSION_3_8, "ascii"));
        this.stage = "security-types";
        return true;
      }

      case "security-types": {
        const types = parseSecurityTypes(this.buffer);
        if (types === null) return false;
        if (types.length === 0) {
          this.onFailed("upstream refused the connection");
          this.stage = "done";
          return false;
        }
        this.buffer = this.buffer.subarray(1 + types.length);
        if (types.includes(RFB_SECURITY.VNC_AUTH)) {
          this.send(Buffer.from([RFB_SECURITY.VNC_AUTH]));
          this.stage = "vnc-challenge";
          return true;
        }
        if (types.includes(RFB_SECURITY.NONE)) {
          // A stream with auth turned off. Still proxied — the password is not
          // what protects it; the panel's token and the input filter are.
          this.send(Buffer.from([RFB_SECURITY.NONE]));
          this.stage = "security-result";
          return true;
        }
        this.onFailed(`no supported security type in [${types.join(",")}]`);
        this.stage = "done";
        return false;
      }

      case "vnc-challenge": {
        if (this.buffer.length < 16) return false;
        const challenge = this.buffer.subarray(0, 16);
        this.buffer = this.buffer.subarray(16);
        this.send(vncAuthResponse(challenge, this.password));
        this.stage = "security-result";
        return true;
      }

      case "security-result": {
        const result = parseSecurityResult(this.buffer);
        if (result === null) return false;
        this.buffer = this.buffer.subarray(4);
        if (result !== 0) {
          this.onFailed("upstream rejected our credentials");
          this.stage = "done";
          return false;
        }
        // Share the desktop: this is a second viewer, never an evictor.
        this.send(clientInit());
        this.stage = "done";
        this.onReady(this.buffer);
        return false;
      }

      case "done":
        return false;
    }
  }
}

export function createComputerBrowserStreamWsHandler(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (err: unknown) => void }
  >,
  deps: BrowserStreamDeps = {},
): MiddlewareHandler {
  const verifyToken = deps.verifyToken ?? verifyComputerBrowserToken;
  const sandboxInfo = deps.sandboxInfo ?? getComputerSandboxInfo;
  const lookupSession = deps.lookupSession ?? lookupBrowserSession;
  const configured = deps.configured ?? isComputersDataPlaneConfigured;
  const bundleHash = deps.bundleHash ?? browserdBundleHash;
  const connectUpstream = deps.connectUpstream ?? wsUpstream;
  const leaseHolder =
    deps.leaseHolder ??
    (async (session: BrowserSessionRecord) => {
      const lease = await new BrowserdClient({
        baseUrl: session.publicOrigin,
        bearer: session.browserdToken,
      }).lease();
      return lease.state === "held" ? lease.holder : null;
    });

  return upgradeWebSocket(async (c) => {
    // The token rides `Sec-WebSocket-Protocol`, exactly as the terminal's
    // does: a browser cannot set a header on a WS handshake, and a query
    // string would land in proxy access logs — which is the failure this whole
    // route exists to undo.
    const protocolHeader = c.req.header("sec-websocket-protocol") ?? "";
    const token = protocolHeader.split(",")[0]?.trim() ?? "";

    let rejectCode: number | null = null;
    let rejectMessage = "";
    let session: BrowserSessionRecord | null = null;
    let viewerId = "";

    if (!configured()) {
      rejectCode = CLOSE_UNAVAILABLE;
      rejectMessage = "Computers are not configured on this server.";
    } else {
      const claims = await verifyToken(token);
      if (!claims) {
        rejectCode = CLOSE_UNAUTHORIZED;
        rejectMessage = "Invalid or expired browser token.";
      } else {
        viewerId = claims.userId;
        const info = await sandboxInfo({ computerId: claims.computerId });
        if (!info.ok) {
          rejectCode = CLOSE_UNAVAILABLE;
          rejectMessage = `Computer unavailable: ${info.error}`;
        } else if (
          info.value.ownerUserId !== claims.userId ||
          info.value.projectId !== claims.projectId
        ) {
          // The token is good for ~60s and ownership can change inside it, so
          // the row's CURRENT owner is re-checked before any bytes flow. Same
          // reasoning as the panel's own routes.
          rejectCode = CLOSE_UNAUTHORIZED;
          rejectMessage = "Invalid or expired browser token.";
        } else {
          const lookup = await lookupSession({
            computerId: claims.computerId,
            expectedBundleHash: bundleHash(),
            expectedContextMode: "persistent",
          });
          if (!lookup.session) {
            rejectCode = CLOSE_GONE;
            rejectMessage = "No browser is running on this computer.";
          } else {
            session = lookup.session;
          }
        }
      }
    }

    return {
      onOpen: (_evt, ws) => {
        if (rejectCode !== null || !session) {
          ws.close(
            rejectCode ?? CLOSE_UNAVAILABLE,
            rejectMessage.slice(0, 120),
          );
          return;
        }
        const live = session;
        const filter = new RfbClientFilter();
        /**
         * The browser's side of the handshake, which is NOT a message stream.
         *
         * After we send it ProtocolVersion, one security type and a success
         * result, an RFB client replies with 12 bytes of ProtocolVersion, one
         * byte selecting a security type, and one byte of ClientInit — before
         * its first real message. Those are not typed messages: fed to the
         * filter, `R` (0x52) reads as message type 82, which is unknown, so
         * the socket would close on the very first thing every client says.
         *
         * Consumed here and NOT relayed: our own handshake upstream is already
         * complete, including the ClientInit that asked to share the desktop.
         */
        let clientHandshakeRemaining = CLIENT_HANDSHAKE_BYTES;
        let upstream: UpstreamSocket | null = null;
        let ready = false;
        let closed = false;
        let leaseCheckedAt = 0;
        /** Orders overlapping lease reads; only the newest may apply. */
        let leaseGeneration = 0;
        let leaseTimer: ReturnType<typeof setInterval> | null = null;
        let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

        const shutdown = (code: number, reason: string) => {
          if (closed) return;
          closed = true;
          if (leaseTimer) clearInterval(leaseTimer);
          if (handshakeTimer) clearTimeout(handshakeTimer);
          upstream?.close();
          try {
            ws.close(code, reason.slice(0, 120));
          } catch {
            /* already gone */
          }
        };

        /**
         * Re-read who holds the browser, and tell the filter.
         *
         * Polled rather than pushed because the lease lives in the daemon and
         * can change without this socket hearing anything — a person hands
         * control back from the panel, or their lease times out and parks.
         * Failing closed on an unreadable lease is deliberate: not knowing who
         * holds the browser is not a reason to let someone type on it.
         */
        const refreshLease = async () => {
          if (closed) return;
          const now = Date.now();
          if (now - leaseCheckedAt < LEASE_CACHE_MS) return;
          leaseCheckedAt = now;
          // The cache window bounds how OFTEN a read starts, not how long one
          // takes. A slow read and the next one can overlap, and applying them
          // in completion order lets a stale "you hold it" land after a fresh
          // "they took it back" — re-enabling a viewer's keyboard on somebody
          // else's desktop until the following tick. Only the newest read may
          // GRANT input; see the catch for why refusals are not ordered.
          const generation = ++leaseGeneration;
          try {
            const holder = await leaseHolder(live);
            if (generation !== leaseGeneration || closed) return;
            filter.setHoldsInput(holder === viewerId);
          } catch {
            // NO generation check here, deliberately. The guard above orders
            // successes; applying it to failures inverts the module's whole
            // policy. During a control-plane outage every read takes its full
            // timeout while fresh ones start every two seconds, so each
            // failure is always "stale" by the time it lands — and suppressing
            // them all leaves a viewer's input enabled indefinitely on a lease
            // nobody can read. Not knowing who holds the browser is not a
            // reason to let somebody type on it, whichever read found out.
            if (closed) return;
            filter.setHoldsInput(false);
          }
        };

        upstream = connectUpstream(live);
        const handshake = new UpstreamHandshake(
          live.streamPassword,
          (data) => upstream?.send(data),
          (leftover) => {
            ready = true;
            if (handshakeTimer) clearTimeout(handshakeTimer);
            // The browser's own handshake, now that ours has succeeded: our
            // version, ONE security type (None), and a success result. It
            // never sees a challenge because it has no password to answer one
            // with, which is the entire point.
            ws.send(bytes(Buffer.from(RFB_PROTOCOL_VERSION_3_8, "ascii")));
            ws.send(bytes(securityTypesOffer()));
            ws.send(bytes(securityResultOk()));
            // Whatever the server had already sent past its handshake is the
            // start of the message stream and belongs to the browser.
            if (leftover.length > 0) ws.send(bytes(Buffer.from(leftover)));
            void refreshLease();
            leaseTimer = setInterval(() => void refreshLease(), LEASE_CACHE_MS);
            leaseTimer.unref?.();
          },
          (reason) => {
            logger.warn("[computers] browser stream handshake failed", {
              computerId: live.computerId,
              reason,
            });
            shutdown(CLOSE_UNAVAILABLE, "Could not reach the browser stream.");
          },
        );

        handshakeTimer = setTimeout(() => {
          if (!ready) {
            shutdown(CLOSE_UNAVAILABLE, "The browser stream did not respond.");
          }
        }, HANDSHAKE_TIMEOUT_MS);
        handshakeTimer.unref?.();

        upstream.onMessage((data) => {
          if (closed) return;
          // Server→client needs no filtering: it is pixels, and the panel is
          // allowed to watch. Only the other direction carries authority.
          if (handshake.finished) ws.send(bytes(Buffer.from(data)));
          else handshake.push(data);
        });
        upstream.onError((error) => {
          logger.warn("[computers] browser stream upstream error", {
            computerId: live.computerId,
            error: error instanceof Error ? error.message : String(error),
          });
          shutdown(CLOSE_UNAVAILABLE, "The browser stream failed.");
        });
        upstream.onClose(() =>
          shutdown(CLOSE_GONE, "The browser stream ended."),
        );

        // Stashed for `onMessage` below, which has no closure over these.
        socketState.set(ws as object, {
          filter,
          upstreamRef: () => upstream,
          ready: () => ready,
          shutdown,
          /** Eat the browser's handshake reply; return whatever follows it. */
          consumeHandshake: (chunk) => {
            if (clientHandshakeRemaining === 0) return chunk;
            const eaten = Math.min(clientHandshakeRemaining, chunk.length);
            clientHandshakeRemaining -= eaten;
            return chunk.subarray(eaten);
          },
        });
      },

      onMessage: (event, ws) => {
        const state = socketState.get(ws as object);
        if (!state || !state.ready()) return;
        const incoming = toBytes(event.data);
        if (!incoming) return;
        const data = state.consumeHandshake(incoming);
        if (data.length === 0) return;
        const result = state.filter.push(data);
        if (!result.ok) {
          // A stream we cannot parse is one whose input we cannot reliably
          // block, so it does not get to continue.
          state.shutdown(CLOSE_UNAVAILABLE, "Malformed stream.");
          return;
        }
        if (result.forward.length > 0) {
          state.upstreamRef()?.send(result.forward);
        }
      },

      onClose: (_evt, ws) => {
        const state = socketState.get(ws as object);
        state?.shutdown(1000, "closed");
        socketState.delete(ws as object);
      },

      onError: (_evt, ws) => {
        const state = socketState.get(ws as object);
        state?.shutdown(CLOSE_UNAVAILABLE, "stream error");
        socketState.delete(ws as object);
      },
    };
  });
}

/** Per-socket state, since the handler's callbacks do not share a closure. */
const socketState = new WeakMap<
  object,
  {
    filter: RfbClientFilter;
    upstreamRef: () => UpstreamSocket | null;
    ready: () => boolean;
    shutdown: (code: number, reason: string) => void;
    consumeHandshake: (chunk: Uint8Array) => Uint8Array;
  }
>();

/**
 * A detached `Uint8Array` copy, which is what the socket's `send` accepts.
 *
 * Node's `Buffer` is a view over a pooled `ArrayBufferLike`, and the socket
 * types (rightly) want a plain `ArrayBuffer` — a pooled view handed to an
 * async send can be scribbled over by the next allocation before it goes out.
 */
function bytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(buffer.byteLength));
  copy.set(buffer);
  return copy;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}
