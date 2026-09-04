/**
 * Client state for the WebMCP Inspector: one browser session, its live tool
 * registry, and its activity timeline.
 *
 * The server is the source of truth for all three. This store holds what the
 * SSE stream has told it, which is why every server message that carries tools
 * carries the FULL set rather than a delta — a reconnecting client can adopt a
 * snapshot without reasoning about what it missed.
 */
import { create } from "zustand";
import {
  addTokenToUrl,
  getAuthHeaders,
  hasSessionToken,
} from "@/lib/session-token";
import {
  WEBMCP_INPUT_BATCH_LIMIT,
  type WebMcpInvocationOutcome,
} from "@/shared/webmcp-inspector-protocol";
import { isHostedMode } from "@/lib/apis/mode-client";
import { authFetch } from "@/lib/session-token";
import type {
  WebMcpActivityEntry,
  WebMcpBinaryFrame,
  WebMcpCommand,
  WebMcpEvent,
  WebMcpInputEvent,
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";
import {
  createFramePresenter,
  type FramePresenter,
} from "@/lib/webmcp-inspector/frame-presenter";
import {
  FRAME_WS_CLOSE,
  openWebMcpFrameStream,
  type FrameStreamConnection,
} from "@/lib/webmcp-inspector/frame-stream-connection";
import {
  noteFrameTransportRung,
  noteInputSent,
  resetFrameStats,
} from "@/lib/webmcp-inspector/frame-stats";

/**
 * WHERE the inspector API lives, which differs by deployment.
 *
 * Locally it hangs off `/api/mcp`, whose whole family is 410'd on a hosted
 * replica; hosted, the same router is mounted under `/api/web` alongside every
 * other route a browser can reach there. Read once at module load, because the
 * mode is a build constant and cannot change under a running tab.
 */
const BASE = isHostedMode() ? "/api/web/webmcp" : "/api/mcp/webmcp";
/** Timeline entries kept in memory. Older ones scroll out of usefulness. */
const MAX_ACTIVITY = 500;

export interface WebMcpRequestError {
  message: string;
  /** Server-assigned code, e.g. `webmcp-unsupported`, so the UI can explain. */
  code?: string;
}

export interface PendingInvocation {
  invokeId: string;
  toolKey: string;
  startedAt: number;
}

/** The settled outcome of one invocation, as a caller awaiting it sees it. */
export interface PageToolInvocationResult extends WebMcpInvocationOutcome {
  /**
   * Present when the outcome is `unknown` and the caller may ask again: the
   * same id re-queries the same invocation rather than starting a new one.
   */
  invokeId?: string;
}

/** How long to wait for a settle event before giving up on the stream. */
const INVOCATION_WAIT_TIMEOUT_MS = 90_000;

/**
 * A client-minted id for one invocation, so a retry is recognisable as one.
 *
 * `crypto.randomUUID` needs a secure context, which every real deployment is;
 * the fallback keeps this working in a plain-HTTP dev origin rather than
 * throwing on the first tool call.
 */
function newInvokeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The frame currently on screen, normalized across BOTH transports.
 *
 * `src` is whatever an `<img>` can render: a data URI for a frame that came
 * over SSE, a blob URL for one that came over the WebSocket. The pane renders
 * it verbatim, which is what lets the transport change underneath without the
 * letterbox and coordinate arithmetic knowing.
 *
 * `seq` rides along because it is the session's single monotonic counter,
 * shared by both transports — and therefore the only way to tell a straggling
 * SSE frame from a newer WS one while the two overlap.
 */
export interface WebMcpLiveFrame {
  src: string;
  deviceWidth: number;
  deviceHeight: number;
  /**
   * The same surface in CSS pixels — what the PAGE thinks its own coordinates
   * are, and therefore what every forwarded click has to be expressed in.
   *
   * REQUIRED rather than derived at each use site. A session's frames need not
   * all arrive at the same scale (a still captured at full device resolution
   * can land between two streamed frames captured at CSS resolution), so a
   * consumer that forgot to divide would be right for some frames of the same
   * session and wrong for others — the hardest kind of coordinate bug to see.
   */
  cssWidth: number;
  cssHeight: number;
  ts: number;
  seq: number;
  /**
   * The transport this frame ARRIVED on.
   *
   * Stamped here rather than read when the frame paints: a frame decodes for
   * tens of milliseconds, the ladder can move inside that window, and a socket
   * frame filed under the transport that replaced it makes the split
   * percentiles describe neither.
   */
  rung: WebMcpFrameTransport["rung"];
}

/**
 * The viewer's own device pixel ratio, as a request field — or nothing at all.
 *
 * OMITTED at 1, which is both the server's default and what every client older
 * than this field sends, so the common case puts nothing new on the wire and an
 * older server strips nothing. Clamped to the range the server accepts and
 * rounded to THREE decimals, because `devicePixelRatio` on a zoomed browser is
 * a long float and three decimals is what a frame's own `scale` carries — the
 * two describe the same ratio and should not disagree in the third place.
 */
function devicePixelRatioField(): { devicePixelRatio?: number } {
  if (typeof window === "undefined") return {};
  const raw = window.devicePixelRatio;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return {};
  const ratio = Math.round(Math.min(2, Math.max(1, raw)) * 1_000) / 1_000;
  return ratio === 1 ? {} : { devicePixelRatio: ratio };
}

/**
 * Normalize a frame from either transport into what the pane renders.
 *
 * One function for both, because the CSS-pixel arithmetic is the part that
 * must not differ between them: two copies is how the SSE path and the socket
 * path end up disagreeing about where a click landed.
 */
function toLiveFrame(
  src: string,
  frame: {
    deviceWidth: number;
    deviceHeight: number;
    ts: number;
    scale?: number;
  },
  seq: number,
  rung: WebMcpFrameTransport["rung"],
): WebMcpLiveFrame {
  // A missing, zero or nonsense scale reads as 1: an older server never sends
  // one, and dividing by a bad number would put the pane's geometry somewhere
  // no click could reach.
  const scale =
    typeof frame.scale === "number" &&
    Number.isFinite(frame.scale) &&
    frame.scale > 0
      ? frame.scale
      : 1;
  return {
    src,
    deviceWidth: frame.deviceWidth,
    deviceHeight: frame.deviceHeight,
    cssWidth: Math.round(frame.deviceWidth / scale),
    cssHeight: Math.round(frame.deviceHeight / scale),
    ts: frame.ts,
    seq,
    rung,
  };
}

/**
 * How the pane is getting its pixels, and how hard that was.
 *
 * `ws` is the binary socket, `sse-frames` the JSON stream it falls back to,
 * `poll` the screenshot loop for a server too old to screencast at all, and
 * `none` no stream at all.
 */
export interface WebMcpFrameTransport {
  rung: "ws" | "sse-frames" | "poll" | "none";
  /** Socket attempts spent on this session; reset by one that opens. */
  attempts: number;
  /** The ladder has given up climbing back to the socket. */
  latched: boolean;
}

/** Where a session's browser runs. See `startSession`. */
export interface StartSessionOptions {
  transport?: "local" | "hosted";
  /** Required when `transport` is `"hosted"`. */
  projectId?: string;
  /**
   * WHERE the person watches and drives the page.
   *
   * `"in-app"` is what the inspector's own UI sends: no window, the page lives
   * in the pane. `"window"` is the original behaviour, and is what a caller
   * that omits this gets — the field is left off the request entirely, so an
   * older server that has never heard of it behaves exactly as it does today.
   */
  display?: "window" | "in-app";
  /**
   * A Chromium surface the client has already mounted, for the server to
   * attach to instead of launching a browser.
   *
   * Only ever set inside the desktop app, and only alongside `display:
   * "in-app"` — the server refuses every other combination. Omitted otherwise,
   * so a server that has never heard of the field starts an ordinary in-app
   * session and the client renders the frame-stream pane it is handed.
   */
  webContentsId?: number;
}

interface WebMcpInspectorState {
  session: WebMcpSessionPublic | undefined;
  tools: WebMcpToolDescriptor[];
  activity: WebMcpActivityEntry[];
  pending: PendingInvocation[];
  /** True between "user asked to open" and the server answering. */
  starting: boolean;
  error: WebMcpRequestError | undefined;
  /**
   * The last frame the viewport stream delivered.
   *
   * Deliberately separate from `lastScreenshot`, which is the MANUAL capture
   * the Screenshot button fills and the thumbnail beside the invoke pane reads.
   * They have different budgets, different lifetimes and different meanings —
   * one is the live picture, the other is a snapshot someone asked for — and
   * collapsing them would make the thumbnail flicker with every paint.
   */
  liveFrame: WebMcpLiveFrame | undefined;
  /**
   * WHICH transport is actually carrying the pane's pixels right now.
   *
   * The ladder degrades silently on purpose — a pane that keeps painting
   * through a dead socket is the whole point — which leaves no way to tell a
   * working session from one quietly running on the slowest path it has. This
   * is that way: `rung` is what pixels are arriving on, `attempts` is how many
   * socket tries this session has spent, and `latched` says the ladder has
   * stopped trying to climb back.
   *
   * DERIVED, never stored twice: the ladder and the screenshot poll are
   * independent (an old server produces both — 1006 on the socket and a
   * refused `set_screencast`), and two writers racing over one field is how a
   * badge ends up contradicting the pane beside it.
   */
  frameTransport: WebMcpFrameTransport;
  lastScreenshot: string | undefined;
  /**
   * When the server captured the picture in `lastScreenshot`, IF the poll took
   * it.
   *
   * Written in the same `set` as the picture itself, so the two cannot drift,
   * and deliberately `undefined` for a manual capture. Its only reader is the
   * frame-stats measurement, and what that records is a TRANSPORT: a person
   * pressing the Screenshot button is not the pane polling, and filing it
   * under `poll` would invent that transport for a session streaming happily —
   * or for a headless one, where the button is the only way to see the page
   * and nothing polls at all.
   *
   * The timestamp is the server's own, because the measurement needs the same
   * definition of "captured" that a streamed frame's `ts` carries — otherwise
   * the poll's percentile is a different quantity sharing a table with the
   * socket's, which is the one thing that module exists to avoid.
   */
  lastScreenshotAt: number | undefined;
  /**
   * Whether chat turns may use this page's tools. Off by default and reset when
   * a session closes: a chat should never silently acquire tools because a
   * browser was left open somewhere else in the app.
   */
  chatEnabled: boolean;
  setChatEnabled(enabled: boolean): void;
  /**
   * Whether this turn may advertise the page's tools: opted in AND still
   * attached to a live browser.
   */
  pageToolsLive(): boolean;

  /**
   * Open a browser at `url`.
   *
   * `options.transport` picks WHERE it runs: omitted or `"local"` opens a
   * window on this machine (the default, unchanged); `"hosted"` runs it on the
   * project's MCPJam computer and needs `projectId`, because that is the
   * computer being reserved and billed.
   */
  startSession(
    url: string,
    options?: StartSessionOptions,
  ): Promise<string | undefined>;
  closeSession(): Promise<void>;
  sendCommand(command: WebMcpCommand): Promise<unknown>;
  invokeTool(toolKey: string, input: Record<string, unknown>): Promise<void>;
  /**
   * Invoke and wait for the result, for callers that need the value rather
   * than the timeline — chat, which must hand the model back what it asked for.
   */
  invokeToolForResult(
    toolKey: string,
    input: Record<string, unknown>,
  ): Promise<PageToolInvocationResult>;
  cancelInvocation(invokeId: string): Promise<void>;
  /**
   * Capture the page into `lastScreenshot`.
   *
   * `silent` is for the background poll: it neither sets nor clears `error`, so
   * a once-a-second capture cannot erase the banner from a navigation or
   * invocation failure before anyone has read it.
   */
  captureScreenshot(options?: { silent?: boolean }): Promise<void>;
  /**
   * Ask the server to start or stop streaming the viewport.
   *
   * Reports whether the server took it. `false` means this server predates
   * `set_screencast` (it 400s an unknown command), which is the client's cue to
   * fall back to polling screenshots rather than showing an empty pane.
   */
  setScreencast(enabled: boolean): Promise<boolean>;
  /** Drive the page from the pane. Batched by the caller, not here. */
  sendInput(events: WebMcpInputEvent[]): Promise<void>;
  clearError(): void;
  /**
   * Re-attach the event stream to the session that is still running, e.g. after
   * the surface unmounts and mounts again. Idempotent for the same session.
   */
  reconnect(): void;
  /**
   * Report that the screenshot POLL is running, or has stopped.
   *
   * Owned by the surface rather than inferred here, because the poll is the
   * surface's own fallback: it starts it when `set_screencast` comes back
   * refused, and only it knows when its pane went away.
   */
  noteScreenshotPolling(active: boolean): void;
  /** Test seam; also used when the surface unmounts. */
  disconnect(): void;
}

/**
 * One EventSource per session, module-scoped rather than per-component: the
 * workspace renders several panels off this store, and a stream per panel would
 * multiply both the connections and the replayed history.
 */
let source: EventSource | undefined;
/**
 * The hosted event stream's abort handle, and a generation counter so a
 * reconnect loop belonging to a stream that has since been replaced cannot
 * resurrect itself.
 */
let hostedStream: AbortController | undefined;
let hostedStreamGeneration = 0;
/** Backoff for the hosted stream's own reconnects (EventSource does its own). */
const HOSTED_STREAM_RETRY_MS = [500, 1_000, 2_000, 5_000];
let sourceSessionId: string | undefined;
/** Whether the CURRENT EventSource asked for frames to be suppressed. */
let sourceFrames: "on" | "off" = "on";

/**
 * The binary frame socket, for `frame-stream` sessions only.
 *
 * A second transport rather than a replacement: SSE still carries the session,
 * its tools and its timeline, which are small, ordered and worth replaying.
 * Only the pixels move — they are the one thing big enough and frequent enough
 * for the base64-in-JSON tax to be the difference between a live pane and a
 * laggy one.
 */
let frameSocket: FrameStreamConnection | undefined;
let frameRetryTimer: ReturnType<typeof setTimeout> | undefined;
/** Attempts made for THIS session, initial included. */
let frameAttempts = 0;
/** Set once we stop trying: frames stay on SSE for the rest of the session. */
let frameSocketLatched = false;
/** Which stream the LADDER is currently on, before the poll is considered. */
let ladderRung: "ws" | "sse-frames" | "none" = "none";
/** Whether the surface's screenshot poll is running. */
let polling = false;

/**
 * Delays before the 2nd, 3rd and 4th attempt. FOUR TOTAL, then never again for
 * this session.
 *
 * A bounded ladder rather than an endless backoff because the failure this is
 * really for is structural — a server too old to serve the route answers 1006
 * every time — and reconnecting forever against it would be a socket churning
 * in the background of a pane that is already working fine on SSE.
 */
const FRAME_WS_RETRY_DELAYS_MS = [500, 1_000, 2_000];

/**
 * Bumped by every full teardown and every session change.
 *
 * Every WebSocket callback and every retry timer captures it at creation and
 * no-ops when it no longer matches. That single check is what makes a late
 * message, a close event racing our own `close()`, or an armed retry timer
 * incapable of touching the session that replaced theirs — including opening a
 * zombie socket against it.
 */
let connectionGeneration = 0;

/**
 * The newest frame seq applied, across BOTH transports.
 *
 * Both paths drop anything at or below it. The case this exists for is the
 * transport switch: while the ladder flips SSE frames back on, a frame already
 * in the SSE pipe can land after a newer one from the socket, and painting it
 * would drag the pane backwards to an older picture.
 */
let lastAppliedFrameSeq = 0;

/** Owns the blob URLs behind WS frames, and their delayed revocation. */
let presenter: FramePresenter = createFramePresenter();

/** Test seam: lets a suite inject fake URL plumbing. */
export function setFramePresenterForTests(next: FramePresenter): void {
  presenter = next;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: WebMcpRequestError }> {
  try {
    // `authFetch` rather than a bare `fetch`: hosted requests need the signed-in
    // member's bearer, which `getAuthHeaders` deliberately does not supply (it
    // carries the LOCAL session token, and is a no-op hosted). It keeps adding
    // that local token for local mode, so this one call covers both.
    const response = await authFetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...getAuthHeaders(),
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: {
          message:
            typeof body?.error === "string"
              ? body.error
              : "The WebMCP Inspector request failed.",
          code: typeof body?.code === "string" ? body.code : undefined,
        },
      };
    }
    return { ok: true, data: body as T };
  } catch (error) {
    return {
      ok: false,
      error: {
        message:
          error instanceof Error
            ? error.message
            : "Could not reach the WebMCP Inspector.",
      },
    };
  }
}

/**
 * Callers awaiting a specific invocation, keyed by invokeId.
 *
 * The settle arrives on the SSE stream rather than as an HTTP response — the
 * invoke request answers as soon as the call is queued — so a caller that needs
 * the value parks here and the stream handler resolves it.
 */
const invocationWaiters = new Map<
  string,
  (result: PageToolInvocationResult) => void
>();

/**
 * Activity ids already applied.
 *
 * EventSource reconnects on its own, and every reconnect replays the ring, so
 * the same entries arrive more than once. Appending them blindly would show the
 * timeline doubled, hand React duplicate keys, and — worse — re-add an
 * `invocation_started` whose `invocation_settled` has scrolled out of the replay
 * window, leaving a tool stuck showing "Running…" with Invoke disabled.
 */
let seenActivityIds = new Set<string>();

/**
 * Results that arrived before anyone was waiting for them.
 *
 * `invokePageTool` can only register its waiter after the invoke POST responds
 * with an id, and a fast tool can settle on the stream before that. Without
 * this the result would be dropped, the dedup above would refuse the replayed
 * copy, and the caller would sit out the full timeout before reporting a
 * failure for a tool that actually succeeded.
 *
 * Bounded like the activity ring, since a caller that never arrives must not
 * pin results for the life of the tab.
 */
const settledResults = new Map<string, PageToolInvocationResult>();
const MAX_EARLY_SETTLES = 64;

function rememberSettled(invokeId: string, result: PageToolInvocationResult) {
  settledResults.set(invokeId, result);
  while (settledResults.size > MAX_EARLY_SETTLES) {
    const oldest = settledResults.keys().next().value;
    if (oldest === undefined) break;
    settledResults.delete(oldest);
  }
}

/**
 * Settle every caller still waiting on this session.
 *
 * Called when the session goes away for any reason. Without it a model turn
 * blocked on a page tool would wait out the full timeout after the browser it
 * was talking to had already closed.
 */
function failOutstandingWaiters(errorMessage: string) {
  sessionGeneration += 1;
  for (const [invokeId, waiter] of [...invocationWaiters]) {
    invocationWaiters.delete(invokeId);
    waiter({ state: "failed", errorMessage });
  }
  settledResults.clear();
}

/**
 * Bumped every time a session goes away.
 *
 * A caller cannot park on its waiter until the invoke POST answers with an id,
 * so a close landing during that round trip would find nothing to settle and
 * the waiter registered a moment later would wait out the full timeout.
 * Comparing the generation across the await closes that window from the other
 * side.
 */
let sessionGeneration = 0;

/**
 * A tail promise that serializes the commands whose ORDER is the whole point.
 *
 * Two of them: input, where a release applied before its press turns a click
 * into a stuck drag; and the screencast toggle, where an enable landing after a
 * disable leaves Chromium encoding for a pane nobody is looking at. Both are
 * fired from UI events that can overlap, and `fetch` makes no promise at all
 * about the order two in-flight requests reach a handler.
 *
 * Rejections are folded into the chain so one failed command cannot wedge every
 * later one.
 */
let commandTail: Promise<unknown> = Promise.resolve();

/**
 * Ordering for screenshot captures, which — unlike commands — are deliberately
 * NOT serialized: the poll must keep its cadence rather than queue behind a
 * slow capture.
 *
 * So they can overlap, and a capture that started earlier can answer later. The
 * ticket says which picture is newer; without it a slow poll lands on top of a
 * manual capture someone just asked for, and the pane shows the older page
 * until the next tick.
 */
let captureIssued = 0;
let captureApplied = 0;

function inOrder<T>(run: () => Promise<T>): Promise<T> {
  const next = commandTail.then(run, run);
  commandTail = next.catch(() => {});
  return next;
}

export const useWebmcpInspectorStore = create<WebMcpInspectorState>(
  (set, get) => {
    /**
     * Recompute what the pane's pixels are arriving on, and publish it if it
     * changed.
     *
     * DERIVED from the ladder's own variables rather than written at each
     * site, which removes every ordering hazard between the two independent
     * things that can degrade: the socket ladder and the screenshot poll. An
     * older server produces BOTH — 1006 on the socket and a refused
     * `set_screencast` — and two writers racing over one field is how a badge
     * ends up contradicting the pane beside it.
     */
    function publishFrameTransport() {
      const rung = polling ? "poll" : ladderRung;
      const next: WebMcpFrameTransport = {
        rung,
        attempts: frameAttempts,
        latched: frameSocketLatched,
      };
      const current = get().frameTransport;
      if (
        current.rung === next.rung &&
        current.attempts === next.attempts &&
        current.latched === next.latched
      ) {
        return;
      }
      set({ frameTransport: next });
      // The measurement split follows the transport: a p95 that mixes socket
      // frames with polled screenshots describes neither.
      noteFrameTransportRung(rung);
    }

    /**
     * Apply one server event.
     *
     * An explicit ALLOWLIST of known types, with anything else ignored by
     * design. The previous shape fell through to the activity branch for
     * everything that was not `session` or `tools`, so the first new event type
     * a server learned to send would throw on `event.entry` — and that throw
     * was swallowed by `onmessage`'s catch, which turns "this client is older
     * than this server" into a silent, unexplained gap. Ignoring an unknown
     * type is the same outcome without the mystery, and it is the behaviour a
     * newer server is entitled to expect from an older client.
     */
    function applyEvent(event: WebMcpEvent) {
      if (event.type === "session") {
        if (event.session.status === "detached") {
          // The REMOTE browser is still running; this replica just let go of
          // its handle. Recoverable, and recovered by asking for the session
          // again — any replica can re-derive it. Treating this like `closed`
          // would tell someone their live browser had ended, and drop a
          // timeline they can still add to.
          void reattach(event.session.sessionId);
          return;
        }
        set({ session: event.session });
        return;
      }
      if (event.type === "tools") {
        set({ tools: event.tools });
        return;
      }
      if (event.type === "frame") {
        // The seq guard, on the SSE side. A frame that predates what is on
        // screen is not news, and during a transport flip it is actively
        // wrong: it would drag the pane back to an older picture.
        if (event.seq <= lastAppliedFrameSeq) return;
        lastAppliedFrameSeq = event.seq;
        set({
          liveFrame: toLiveFrame(
            `data:image/jpeg;base64,${event.frame.data}`,
            event.frame,
            event.seq,
            // This frame came in on the event stream, whatever else is
            // running: a screenshot poll alongside it does not change how THIS
            // picture arrived, and tagging it `poll` would file its latency
            // under a transport that did not carry it.
            "sse-frames",
          ),
        });
        return;
      }
      if (event.type !== "activity") return;
      const entry = event.entry;
      if (seenActivityIds.has(entry.id)) return;
      seenActivityIds.add(entry.id);
      set((state) => {
        const activity = [...state.activity, entry].slice(-MAX_ACTIVITY);
        let pending = state.pending;
        if (entry.kind === "invocation_started") {
          pending = [
            ...state.pending,
            {
              invokeId: entry.invokeId,
              toolKey: entry.toolKey,
              startedAt: entry.ts,
            },
          ];
        } else if (entry.kind === "invocation_settled") {
          pending = state.pending.filter(
            (item) => item.invokeId !== entry.invokeId,
          );
        }
        return { activity, pending };
      });

      if (entry.kind === "invocation_settled") {
        const result: PageToolInvocationResult = {
          state: entry.state,
          output: entry.output,
          outputTruncated: entry.outputTruncated,
          outputBytes: entry.outputBytes,
          errorMessage: entry.errorMessage,
        };
        const waiter = invocationWaiters.get(entry.invokeId);
        if (waiter) {
          invocationWaiters.delete(entry.invokeId);
          waiter(result);
        } else {
          // Nobody is parked on this yet — hold it for the caller still waiting
          // on the invoke POST to come back with the id.
          rememberSettled(entry.invokeId, result);
        }
      }
    }

    /**
     * Apply one frame that arrived over the binary socket.
     *
     * The blob URL is minted here rather than in the pane, because the
     * presenter's whole job — revoking URL N−2 as URL N is created — needs one
     * owner that sees every frame in order.
     */
    function applyBinaryFrame(frame: WebMcpBinaryFrame) {
      if (frame.seq <= lastAppliedFrameSeq) return;
      lastAppliedFrameSeq = frame.seq;
      set({
        liveFrame: toLiveFrame(
          presenter.present(frame.jpeg),
          frame,
          frame.seq,
          "ws",
        ),
      });
    }

    /**
     * RESET #1 of three: replace the EventSource, and touch NOTHING else.
     *
     * Used when the ladder flips frames on or off. Deliberately not a clear:
     * the pane is showing a perfectly good frame, and revoking the blob it is
     * painted from — or resetting the seq guard that is protecting it — would
     * make a transport change visible as a flicker or a backwards jump. The
     * seq guard alone carries continuity across the flip.
     */
    function openEventSource(sessionId: string, frames: "on" | "off") {
      source?.close();
      // The hosted reader has to go the same way the `EventSource` does.
      // `ensureSseFrames` reopens this stream to turn frames on or off, and a
      // reader left running keeps pulling its old response body and delivering
      // the very frames the reopen asked to stop — two streams feeding one
      // session, the older one contradicting the newer.
      hostedStream?.abort();
      hostedStream = undefined;
      sourceSessionId = sessionId;
      sourceFrames = frames;
      // `frames=on` is never sent — the parameter is OMITTED — so a server
      // that has never heard of it receives exactly today's URL.
      const query = frames === "off" ? "?replay=200&frames=off" : "?replay=200";
      const path = `${BASE}/sessions/${sessionId}/events${query}`;

      /** One SSE payload, whichever transport carried it. */
      const handlePayload = (raw: string) => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.type === "session_gone") {
            // The server restarted, or the session was reaped. Say so rather
            // than leaving a dead tab that looks live.
            set({
              error: {
                message:
                  typeof parsed.error === "string"
                    ? parsed.error
                    : "That browser session is gone.",
                code: "session-not-found",
              },
              session: undefined,
              tools: [],
              pending: [],
              // The stream that fed it is gone, so the picture is a lie the
              // moment we stop being told it is current.
              liveFrame: undefined,
              lastScreenshot: undefined,
              lastScreenshotAt: undefined,
            });
            failOutstandingWaiters(
              "The browser session went away before this tool finished.",
            );
            disconnectStream();
            return;
          }
          applyEvent(parsed as WebMcpEvent);
        } catch {
          /* a malformed frame is not worth tearing the stream down over */
        }
      };

      // Frames on this stream means the ladder is running on SSE — either
      // because the socket was never opened, or because it fell back here.
      if (frames === "on") {
        ladderRung = "sse-frames";
        publishFrameTransport();
      }

      if (isHostedMode()) {
        // `EventSource` cannot set headers, and hosted auth is a bearer — the
        // query-string accommodation below is a LOCAL session token, which
        // means nothing here. Same pattern the eval run stream uses: authFetch
        // plus a reader over the same `data:` framing.
        openHostedEventStream(path, handlePayload);
        return;
      }

      // The token rides in the query string because EventSource cannot send
      // headers, which is the same accommodation the traffic-log stream makes.
      source = new EventSource(addTokenToUrl(path));
      source.onmessage = (message) => handlePayload(message.data);
      source.onerror = () => {
        // EventSource reconnects on its own, and replay plus full tool
        // snapshots make that safe; nothing to do but let it.
      };
    }

    /**
     * The hosted event stream: `authFetch` plus a reader, reconnecting itself.
     *
     * `EventSource` gives reconnection for free and cannot carry a bearer;
     * this gives up the former to get the latter. Reconnection is therefore
     * explicit — and safe for the same reason it is safe for `EventSource`:
     * every reconnect replays the recent ring and re-sends the complete tool
     * snapshot, so a gap cannot leave stale state behind.
     */
    function openHostedEventStream(
      path: string,
      onPayload: (raw: string) => void,
    ) {
      const controller = new AbortController();
      hostedStream = controller;
      const generation = ++hostedStreamGeneration;

      void (async () => {
        let attempt = 0;
        while (
          !controller.signal.aborted &&
          generation === hostedStreamGeneration
        ) {
          try {
            const response = await authFetch(path, {
              headers: { accept: "text/event-stream" },
              signal: controller.signal,
            });
            if (!response.ok || !response.body) {
              // A 409 here is the interesting one: the computer is asleep, and
              // the session is recoverable rather than gone. Surfaced through
              // the same error channel a failed request would use, so the tab
              // can offer to start it again.
              const body = await response.json().catch(() => ({}));
              set({
                error: {
                  message:
                    typeof body?.error === "string"
                      ? body.error
                      : "The browser session stream is unavailable.",
                  code: typeof body?.code === "string" ? body.code : undefined,
                },
              });
              // Cleared on the way out, because `connect()` reads this handle
              // to decide whether a stream is already open for this session.
              // Left set, a stream that gave up on a 409 looks live forever
              // and every later `reconnect()` declines to replace it — so a
              // computer that has since woken is never picked back up.
              if (generation === hostedStreamGeneration) {
                hostedStream = undefined;
              }
              return;
            }
            attempt = 0;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffered = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              // Checked per CHUNK, not only per reconnect: abort is what ends
              // the read, and a chunk already in flight when it happens would
              // otherwise be applied to whatever session took this one's
              // place.
              if (
                controller.signal.aborted ||
                generation !== hostedStreamGeneration
              ) {
                await reader.cancel().catch(() => {});
                return;
              }
              buffered += decoder.decode(value, { stream: true });
              // SSE frames end at a blank line; a chunk can hold several, or
              // half of one.
              let split = buffered.indexOf("\n\n");
              while (split !== -1) {
                const frame = buffered.slice(0, split);
                buffered = buffered.slice(split + 2);
                for (const line of frame.split("\n")) {
                  if (line.startsWith("data: ")) onPayload(line.slice(6));
                }
                split = buffered.indexOf("\n\n");
              }
            }
          } catch {
            if (controller.signal.aborted) return;
          }
          if (
            controller.signal.aborted ||
            generation !== hostedStreamGeneration
          ) {
            return;
          }
          // Backs off, but never gives up: a hosted session outlives a deploy,
          // and the replica that dropped this stream is not the one that will
          // answer the reconnect.
          attempt = Math.min(attempt + 1, HOSTED_STREAM_RETRY_MS.length - 1);
          await new Promise((resolve) =>
            setTimeout(resolve, HOSTED_STREAM_RETRY_MS[attempt]),
          );
        }
      })();
    }

    /** Reset #1's other half: flip the SSE frame appetite, nothing more. */
    function ensureSseFrames(sessionId: string, frames: "on" | "off") {
      if (sourceFrames === frames) return;
      openEventSource(sessionId, frames);
    }

    /**
     * Open the binary frame socket, counting this as an attempt.
     *
     * Every callback captures the generation it was created under, so a
     * message, a close, or a retry belonging to a session that has since been
     * replaced can never touch the current one.
     */
    function openFrameSocket(sessionId: string, generation: number) {
      if (frameSocketLatched) return;
      frameAttempts += 1;
      publishFrameTransport();
      frameSocket = openWebMcpFrameStream({
        sessionId,
        onOpen: () => {
          if (generation !== connectionGeneration) return;
          // A socket that opened is proof the failure before it was
          // TRANSIENT. The four-attempt bound exists for the structural case —
          // a server too old to serve this route, answering 1006 every time —
          // and counting drops spread across an hour against it would latch a
          // session that has been working fine, permanently reverting it to
          // the latency this whole change removes.
          frameAttempts = 0;
          ladderRung = "ws";
          publishFrameTransport();
          // Frames are arriving here now, so stop paying for them twice. On
          // the first attempt this is already the case and does nothing; after
          // a successful retry it is what puts SSE back to carrying only the
          // session, its tools and its timeline.
          ensureSseFrames(sessionId, "off");
        },
        onFrame: (frame) => {
          if (generation !== connectionGeneration) return;
          applyBinaryFrame(frame);
        },
        onClose: (code) => {
          if (generation !== connectionGeneration) return;
          handleFrameSocketClose(sessionId, generation, code);
        },
      });
    }

    /**
     * The fallback ladder.
     *
     * Three outcomes, and which one a close gets is decided entirely by its
     * code — which is why the route's codes are part of its contract:
     *
     *   1000 / 4404  The session is over. Nothing to retry, and nothing to
     *                flip: the SSE stream is carrying the reason.
     *   4401 / 4503  Auth, or the feature is off. Retrying cannot fix either,
     *                so fall back to SSE frames and stay there.
     *   anything     A drop, or 1006 from a server too old to serve this
     *                route. Put frames back on SSE IMMEDIATELY — the pane
     *                stays live while we retry — then retry on the ladder, and
     *                latch after the fourth attempt.
     */
    function handleFrameSocketClose(
      sessionId: string,
      generation: number,
      code: number,
    ) {
      frameSocket = undefined;
      if (code === FRAME_WS_CLOSE.NORMAL || code === FRAME_WS_CLOSE.GONE) {
        frameSocketLatched = true;
        // The session is over. Nothing is carrying pixels, and nothing will.
        ladderRung = "none";
        publishFrameTransport();
        return;
      }
      if (
        code === FRAME_WS_CLOSE.UNAUTHORIZED ||
        code === FRAME_WS_CLOSE.UNAVAILABLE
      ) {
        frameSocketLatched = true;
        ensureSseFrames(sessionId, "on");
        publishFrameTransport();
        return;
      }
      // Before the retry, not after it: a pane that went blank for two and a
      // half seconds while a ladder ran would be a worse regression than the
      // lag this whole change is about.
      ensureSseFrames(sessionId, "on");
      const retryIndex = frameAttempts - 1;
      if (retryIndex >= FRAME_WS_RETRY_DELAYS_MS.length) {
        frameSocketLatched = true;
        publishFrameTransport();
        return;
      }
      publishFrameTransport();
      frameRetryTimer = setTimeout(() => {
        frameRetryTimer = undefined;
        // The generation is the guarantee, not the clearTimeout below: a timer
        // that somehow survives a teardown must not open a socket against
        // whatever session replaced its own.
        if (generation !== connectionGeneration) return;
        openFrameSocket(sessionId, generation);
      }, FRAME_WS_RETRY_DELAYS_MS[retryIndex]);
    }

    function connect(sessionId: string) {
      // "Already streaming this session" has two shapes, and checking only for
      // the `EventSource` misses the hosted one entirely — hosted never sets
      // `source`, so this guard never tripped and every `reconnect()` (one per
      // surface mount) tore the stream down and rebuilt it, replaying the last
      // 200 events each time.
      const streaming = isHostedMode() ? hostedStream : source;
      if (streaming && sourceSessionId === sessionId) return;
      disconnectStream();
      // Only a `frame-stream` session has pixels to carry. A native-window
      // session drives its own real browser and a hosted one paints in a
      // datacenter; opening a socket for either would be a connection with
      // nothing to say.
      //
      // The token check is not belt-and-braces: it IS the auth on that socket,
      // so without one the handshake could only ever be refused, and SSE frames
      // are the right answer from the start rather than after a ladder.
      const binaryFrames =
        get().session?.viewportTransport.kind === "frame-stream" &&
        hasSessionToken();
      openEventSource(sessionId, binaryFrames ? "off" : "on");
      if (binaryFrames) openFrameSocket(sessionId, connectionGeneration);
    }

    /**
     * RESET #2 of three: the picture is no longer current, but the session is
     * still alive and its counter still runs.
     *
     * Order matters. `liveFrame` goes first so React has dropped the `src`,
     * and only then does the presenter release the bytes behind it — on a
     * later task, at that. Reversing the two yanks a blob out from under an
     * element still painting it. The seq guard is deliberately NOT reset:
     * the session's counter did not restart, so neither should ours.
     */
    function invalidateFrame() {
      set({ liveFrame: undefined });
      presenter.clear();
    }

    /**
     * RESET #3 of three: full teardown. Everything about this session's
     * transports goes, and the generation bump orphans anything still in
     * flight — a message on the wire, a close event yet to fire, an armed
     * retry.
     *
     * `liveFrame` is cleared here as well as by the callers that have their own
     * `set`, because the blob URLs behind it are revoked below and an `<img>`
     * left pointing at a revoked URL is a broken image.
     */
    /**
     * Pick a detached hosted session back up.
     *
     * A plain re-`GET`: whichever replica answers either has the session or
     * re-derives it, and the response carries the current tools. The timeline
     * is the client's own and is deliberately kept — this is the same session
     * continuing, not a new one.
     */
    async function reattach(sessionId: string) {
      const generation = sessionGeneration;
      const result = await request<{
        session: WebMcpSessionPublic;
        tools: WebMcpToolDescriptor[];
      }>(`/sessions/${sessionId}`);
      // The round trip is not instant, and the person can close this session
      // or open another one inside it. Applying either arm then resurrects a
      // session they have moved on from, or attaches its tools to a page it
      // has nothing to do with.
      if (generation !== sessionGeneration) return;
      if (result.ok) {
        set({ session: result.data.session, tools: result.data.tools });
        return;
      }
      // Could not get it back — the computer is asleep, or it really is gone.
      // Reported with the server's own code so the tab can offer the remedy
      // (`hosted-desktop-asleep` is "start it again", not "it is over").
      set({ error: result.error });
    }

    function disconnectStream() {
      connectionGeneration += 1;
      if (frameRetryTimer !== undefined) {
        clearTimeout(frameRetryTimer);
        frameRetryTimer = undefined;
      }
      frameSocket?.close();
      frameSocket = undefined;
      frameAttempts = 0;
      frameSocketLatched = false;
      ladderRung = "none";
      // `polling` is deliberately NOT cleared: it belongs to the surface that
      // owns the interval, and only that surface knows whether the interval
      // has actually stopped. Clearing it from here would report a transport
      // of `none` for a pane still visibly painting screenshots — this runs on
      // every stream teardown, including ones the poll is unaffected by. The
      // surface reports `false` when its poll really stops, which includes the
      // session change that ends it (its effect is keyed on the session id).
      lastAppliedFrameSeq = 0;
      source?.close();
      source = undefined;
      hostedStreamGeneration += 1;
      hostedStream?.abort();
      hostedStream = undefined;
      sourceSessionId = undefined;
      sourceFrames = "on";
      set({ liveFrame: undefined });
      presenter.clear();
      // Measurement samples belong to the session that produced them. `seq`
      // restarts per session, so a gesture still waiting on its echo would
      // otherwise be settled by an unrelated frame of the NEXT page and
      // recorded as that page's latency.
      resetFrameStats();
      publishFrameTransport();
    }

    return {
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      liveFrame: undefined,
      frameTransport: { rung: "none", attempts: 0, latched: false },
      lastScreenshot: undefined,
      lastScreenshotAt: undefined,
      chatEnabled: false,

      noteScreenshotPolling(active) {
        polling = active;
        publishFrameTransport();
      },

      setChatEnabled(enabled) {
        set({ chatEnabled: enabled });
      },

      pageToolsLive() {
        // A "closed" status arrives as an ordinary session event, which leaves
        // `chatEnabled` and the last tool snapshot untouched. Deriving liveness
        // here means every consumer gets it right; asking each caller to
        // re-check the status is how a dead session's aliases end up advertised
        // to a model.
        const { session, chatEnabled } = get();
        return chatEnabled && Boolean(session) && session?.status !== "closed";
      },

      async startSession(url, options) {
        // A new session starts a new timeline, so the dedup set starts over
        // with it — otherwise it grows for the life of the tab.
        seenActivityIds = new Set();
        settledResults.clear();
        // Full teardown BEFORE the request, not after it: a start that fails
        // would otherwise leave the previous session's socket, retry ladder
        // and stream running with nothing left in the UI that refers to them.
        disconnectStream();
        set({
          starting: true,
          error: undefined,
          activity: [],
          tools: [],
          pending: [],
          liveFrame: undefined,
          // A capture of the LAST page. The pane falls back to it before the
          // first frame arrives, so keeping it would present the previous
          // site's picture as this session's live view.
          lastScreenshot: undefined,
          lastScreenshotAt: undefined,
        });
        const result = await request<WebMcpSessionPublic>("/sessions", {
          method: "POST",
          // `transport` is omitted entirely when local, so an older server
          // that does not know the field behaves exactly as it does today.
          body: JSON.stringify({
            url,
            ...(options?.transport === "hosted"
              ? { transport: "hosted", projectId: options.projectId }
              : {}),
            // Omitted for a window session, so an older server that strips the
            // unknown field lands on exactly the same behaviour it would have
            // chosen anyway.
            ...(options?.display === "in-app" ? { display: "in-app" } : {}),
            // Omitted unless the caller mounted a surface. An older server
            // strips the unknown field and answers with a `frame-stream`
            // session, which the pane renders — a graceful degrade rather than
            // a failed start.
            ...(options?.webContentsId !== undefined
              ? { webContentsId: options.webContentsId }
              : {}),
            // Only for a session whose page is rendered on the server and
            // looked at here. A window session paints on a real display that
            // already knows its own ratio, and a hosted one is watched from
            // the Browser panel.
            ...(options?.display === "in-app" ? devicePixelRatioField() : {}),
          }),
        });
        if (!result.ok) {
          set({ starting: false, error: result.error });
          return undefined;
        }
        set({ session: result.data, starting: false });
        connect(result.data.sessionId);
        // Returned so a caller can tell ITS session apart from whatever the
        // store holds later. An async caller that reads `session` after its
        // await sees whichever session is current, which is not necessarily
        // the one it just created.
        return result.data.sessionId;
      },

      async closeSession() {
        const sessionId = get().session?.sessionId;
        disconnectStream();
        failOutstandingWaiters(
          "The browser session was closed before this tool finished.",
        );
        // Opting the next page in has to be a fresh decision: carrying the
        // choice across sessions would silently grant a DIFFERENT site's tools
        // to chat.
        set({
          session: undefined,
          tools: [],
          pending: [],
          chatEnabled: false,
          liveFrame: undefined,
          lastScreenshot: undefined,
          lastScreenshotAt: undefined,
        });
        if (sessionId) {
          const result = await request(`/sessions/${sessionId}`, {
            method: "DELETE",
          });
          // Surfaced rather than swallowed: the session is already cleared from
          // the UI, so a silent failure leaves a browser window open with no
          // "Close browser" button left to try again with.
          if (!result.ok) set({ error: result.error });
        }
      },

      reconnect() {
        const sessionId = get().session?.sessionId;
        if (sessionId) connect(sessionId);
      },

      async sendCommand(command) {
        const sessionId = get().session?.sessionId;
        if (!sessionId) return undefined;
        const result = await request<unknown>(
          `/sessions/${sessionId}/command`,
          {
            method: "POST",
            body: JSON.stringify(command),
          },
        );
        if (!result.ok) {
          set({ error: result.error });
          return undefined;
        }
        set({ error: undefined });
        return result.data;
      },

      async invokeTool(toolKey, input) {
        const invokeId = newInvokeId();
        const response = (await get().sendCommand({
          type: "invoke_tool",
          toolKey,
          input,
          source: "manual",
          invokeId,
        })) as { outcome?: PageToolInvocationResult } | undefined;
        // Locally the outcome arrives on the activity stream and this response
        // is just an ack. Hosted, the response may be the ONLY settlement this
        // tab ever sees — the stream it is subscribed to can be attached to a
        // different replica than the one that ran the tool — so it is recorded
        // here rather than waited for.
        if (response?.outcome) {
          rememberSettled(invokeId, response.outcome);
        }
      },

      async invokeToolForResult(toolKey, input) {
        const generation = sessionGeneration;
        // MINTED HERE, so this call has one identity for its whole life. A
        // hosted request can be dropped in flight or retried onto another
        // replica, and "did that go through?" must be answerable by asking
        // again rather than by running a side-effecting page tool a second
        // time — which is exactly what a server-issued id cannot do, because
        // a retry would get a new one.
        const invokeId = newInvokeId();
        const response = (await get().sendCommand({
          type: "invoke_tool",
          toolKey,
          input,
          source: "chat",
          invokeId,
        })) as
          { invokeId?: string; outcome?: PageToolInvocationResult } | undefined;

        // HOSTED answers inline, because the event stream carrying the settle
        // may be attached to a different replica than the one that ran the
        // tool. Taken as authoritative when present — but only for the session
        // that asked. This return is BEFORE the generation check further down,
        // so without one here a session closed mid-flight would hand its
        // caller an outcome belonging to a page that is gone.
        if (response?.outcome) {
          settledResults.delete(invokeId);
          if (generation !== sessionGeneration) {
            return {
              state: "unknown",
              invokeId,
              errorMessage:
                "The browser session went away while this tool was running.",
            };
          }
          return response.outcome;
        }

        if (!response?.invokeId) {
          const message =
            get().error?.message ?? "The page tool could not be invoked.";
          // `unknown`, not `failed`, and the id is KEPT. The request may have
          // reached the server and run the tool before its response was lost,
          // and the difference matters for anything that charges a card. The
          // id is what lets a retry be recognised as the same invocation
          // instead of running it a second time.
          return { state: "unknown", invokeId, errorMessage: message };
        }

        if (generation !== sessionGeneration) {
          // The session went away while this call was being queued; nothing
          // will ever settle it.
          return {
            state: "failed",
            errorMessage:
              "The browser session went away before this tool finished.",
          };
        }
        // The settle may already have arrived while the POST was in flight.
        const early = settledResults.get(invokeId);
        if (early) {
          settledResults.delete(invokeId);
          return early;
        }

        return new Promise<PageToolInvocationResult>((resolve) => {
          const timer = setTimeout(() => {
            // The server enforces its own per-invocation timeout, so reaching
            // this one means the settle event itself never arrived — a dropped
            // stream, or a server that went away. Either way the caller gets an
            // answer rather than waiting forever.
            if (!invocationWaiters.delete(invokeId)) return;
            resolve({
              state: "failed",
              errorMessage:
                "Lost track of this invocation — the connection to the browser session dropped.",
            });
          }, INVOCATION_WAIT_TIMEOUT_MS);

          invocationWaiters.set(invokeId, (result) => {
            clearTimeout(timer);
            resolve(result);
          });
        });
      },

      async cancelInvocation(invokeId) {
        await get().sendCommand({ type: "cancel_invocation", invokeId });
      },

      async captureScreenshot(options) {
        const ticket = ++captureIssued;
        /**
         * Claim the slot for this capture, if nothing newer has taken it.
         *
         * Called at the point of WRITING, never before the result is known: a
         * failed capture that claimed the slot on its way to writing nothing
         * would then reject the older successful one behind it, and a single
         * transient poll failure would strand the pane on a stale picture.
         */
        const newest = () => {
          if (ticket < captureApplied) return false;
          captureApplied = ticket;
          return true;
        };
        /**
         * A picture, or nothing to say.
         *
         * An answer that carries no image is NOT a blank page — it is a
         * capture the browser could not produce right now: nothing fit the
         * byte budget, or another capture was already outstanding and the
         * provider holds those at one. Writing it would replace a good picture
         * with an empty pane, and — because a write claims the slot — would
         * also reject the real capture still on its way. The poll runs once a
         * second, so a browser that takes longer than that per capture would
         * discard EVERY successful result and leave the pane blank for as long
         * as it stayed slow.
         *
         * Same reasoning as the failure case above, one step further in: a
         * successful response is not the same thing as a picture.
         */
        const applies = (shot: string | undefined) =>
          shot !== undefined && newest();
        if (!options?.silent) {
          const result = (await get().sendCommand({
            type: "capture_screenshot",
          })) as { screenshotBase64?: string; capturedAt?: number } | undefined;
          if (applies(result?.screenshotBase64)) {
            set({
              lastScreenshot: result?.screenshotBase64,
              // Cleared, not carried: this picture is new, and pairing it with
              // the previous POLL's timestamp would measure a paint that
              // happened seconds ago. See the field — a manual capture is not
              // a transport sample.
              lastScreenshotAt: undefined,
            });
          }
          return;
        }
        // The polling path, which runs once a second and must be INVISIBLE in
        // the error banner. `sendCommand` clears `error` on every success, so
        // polling through it would wipe a navigation or invocation failure
        // within a second of it appearing — usually before anyone read it.
        const sessionId = get().session?.sessionId;
        if (!sessionId) return;
        const result = await request<{
          screenshotBase64?: string;
          capturedAt?: number;
        }>(`/sessions/${sessionId}/command`, {
          method: "POST",
          body: JSON.stringify({ type: "capture_screenshot" }),
        });
        // The poll runs every second and the request outlives a close: landing
        // this write after the session changed would hang the OLD page's paint
        // in the new session's pane, where nothing would ever correct it.
        if (get().session?.sessionId !== sessionId) return;
        if (result.ok && applies(result.data.screenshotBase64)) {
          set({
            lastScreenshot: result.data.screenshotBase64,
            lastScreenshotAt: result.data.capturedAt,
          });
        }
      },

      async sendInput(events) {
        if (events.length === 0) return;
        // Dark unless the stats flag is set. Recorded HERE rather than in the
        // forwarder because this is where the seq currently on screen is
        // known, and "the first paint newer than that" is the definition of a
        // visible echo.
        noteInputSent(lastAppliedFrameSeq);
        // Chunked to the route's cap rather than sent whole and refused. A
        // flush that happened to exceed it would otherwise drop the gesture
        // entirely — the one outcome worse than sending it as two requests.
        const batches: WebMcpInputEvent[][] = [];
        for (let i = 0; i < events.length; i += WEBMCP_INPUT_BATCH_LIMIT) {
          batches.push(events.slice(i, i + WEBMCP_INPUT_BATCH_LIMIT));
        }
        // Bound to the session this input was AIMED at. The chain can hold work
        // across a close-and-reopen, and a click meant for one page landing on
        // the next one is worse than a click that goes nowhere.
        const aimedAt = get().session?.sessionId;
        // Serialized: a release that reached the browser before its press would
        // leave the page mid-drag, and concurrent POSTs give no ordering.
        await inOrder(async () => {
          for (const batch of batches) {
            // Re-checked EVERY batch, not once before the loop: a gesture past
            // the route's cap sends more than one request, and the session can
            // turn over while the first is in flight. The rest would then land
            // on whichever page replaced it.
            if (get().session?.sessionId !== aimedAt) return;
            // Through `sendCommand`, unlike `set_screencast`: input the server
            // refuses is a person's click going nowhere, which they should be
            // told about rather than left to wonder at.
            await get().sendCommand({ type: "input", events: batch });
          }
        });
      },

      async setScreencast(enabled) {
        // Serialized with input and with itself: an enable that reached the
        // server after a disable would leave Chromium encoding for a pane
        // nobody is looking at, and `fetch` promises nothing about the order
        // two in-flight requests are handled in.
        const aimedAt = get().session?.sessionId;
        return inOrder(async () => {
          const sessionId = get().session?.sessionId;
          // Same reasoning as `sendInput`: a toggle queued for one session must
          // not start or stop the stream of whichever session replaced it.
          if (!sessionId || sessionId !== aimedAt) return false;
          // Not routed through `sendCommand`: a server that does not know this
          // command answers 400, and that is a compatibility fact for the
          // caller to act on rather than an error to show the user. Surfacing
          // it in the banner would put "Invalid command" in front of someone
          // whose pane is about to start working anyway, via the poll fallback.
          const result = await request<{ streaming?: boolean }>(
            `/sessions/${sessionId}/command`,
            {
              method: "POST",
              body: JSON.stringify({ type: "set_screencast", enabled }),
            },
          );
          // `ok` says the server understood; `streaming` says frames are
          // actually flowing. They differ exactly when a browser refuses
          // `Page.startScreencast` — which is a 200, and is precisely when the
          // caller must fall back to polling rather than wait for frames.
          const streaming = result.ok && result.data.streaming === true;
          // Nothing is arriving from here on unless frames are flowing.
          // Holding the last one would leave the pane showing a page that has
          // since moved on, with nothing left to correct it. Re-checked after
          // the await: a session that changed under us owns its own frame, and
          // clearing that one would blank a pane that is streaming fine.
          if (!streaming && get().session?.sessionId === aimedAt) {
            invalidateFrame();
          }
          return streaming;
        });
      },

      clearError() {
        set({ error: undefined });
      },

      disconnect() {
        disconnectStream();
      },
    };
  },
);

/** Read the active session id without subscribing to the whole store. */
export function getActiveWebMcpSessionId(): string | undefined {
  return useWebmcpInspectorStore.getState().session?.sessionId;
}
