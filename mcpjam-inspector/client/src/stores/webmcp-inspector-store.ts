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
import { WEBMCP_INPUT_BATCH_LIMIT } from "@/shared/webmcp-inspector-protocol";
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
import { noteInputSent } from "@/lib/webmcp-inspector/frame-stats";

const BASE = "/api/mcp/webmcp";
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
export interface PageToolInvocationResult {
  state: "succeeded" | "failed" | "cancelled" | "timeout";
  output?: unknown;
  outputTruncated?: boolean;
  errorMessage?: string;
}

/** How long to wait for a settle event before giving up on the stream. */
const INVOCATION_WAIT_TIMEOUT_MS = 90_000;

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
  ts: number;
  seq: number;
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
  lastScreenshot: string | undefined;
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
  startSession(url: string, options?: StartSessionOptions): Promise<void>;
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
  /** Test seam; also used when the surface unmounts. */
  disconnect(): void;
}

/**
 * One EventSource per session, module-scoped rather than per-component: the
 * workspace renders several panels off this store, and a stream per panel would
 * multiply both the connections and the replayed history.
 */
let source: EventSource | undefined;
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
    const response = await fetch(`${BASE}${path}`, {
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
          liveFrame: {
            src: `data:image/jpeg;base64,${event.frame.data}`,
            deviceWidth: event.frame.deviceWidth,
            deviceHeight: event.frame.deviceHeight,
            ts: event.frame.ts,
            seq: event.seq,
          },
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
        liveFrame: {
          src: presenter.present(frame.jpeg),
          deviceWidth: frame.deviceWidth,
          deviceHeight: frame.deviceHeight,
          ts: frame.ts,
          seq: frame.seq,
        },
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
      sourceSessionId = sessionId;
      sourceFrames = frames;
      // `frames=on` is never sent — the parameter is OMITTED — so a server
      // that has never heard of it receives exactly today's URL.
      const query = frames === "off" ? "?replay=200&frames=off" : "?replay=200";
      // The token rides in the query string because EventSource cannot send
      // headers, which is the same accommodation the traffic-log stream makes.
      source = new EventSource(
        addTokenToUrl(`${BASE}/sessions/${sessionId}/events${query}`),
      );
      source.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data);
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
      source.onerror = () => {
        // EventSource reconnects on its own, and replay plus full tool
        // snapshots make that safe; nothing to do but let it.
      };
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
        return;
      }
      if (
        code === FRAME_WS_CLOSE.UNAUTHORIZED ||
        code === FRAME_WS_CLOSE.UNAVAILABLE
      ) {
        frameSocketLatched = true;
        ensureSseFrames(sessionId, "on");
        return;
      }
      // Before the retry, not after it: a pane that went blank for two and a
      // half seconds while a ladder ran would be a worse regression than the
      // lag this whole change is about.
      ensureSseFrames(sessionId, "on");
      const retryIndex = frameAttempts - 1;
      if (retryIndex >= FRAME_WS_RETRY_DELAYS_MS.length) {
        frameSocketLatched = true;
        return;
      }
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
      if (source && sourceSessionId === sessionId) return;
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
      lastAppliedFrameSeq = 0;
      source?.close();
      source = undefined;
      sourceSessionId = undefined;
      sourceFrames = "on";
      set({ liveFrame: undefined });
      presenter.clear();
    }

    return {
      session: undefined,
      tools: [],
      activity: [],
      pending: [],
      starting: false,
      error: undefined,
      liveFrame: undefined,
      lastScreenshot: undefined,
      chatEnabled: false,

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
          }),
        });
        if (!result.ok) {
          set({ starting: false, error: result.error });
          return;
        }
        set({ session: result.data, starting: false });
        connect(result.data.sessionId);
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
        // The outcome arrives on the activity stream, not in this response:
        // the server answers as soon as the call is queued.
        await get().sendCommand({
          type: "invoke_tool",
          toolKey,
          input,
          source: "manual",
        });
      },

      async invokeToolForResult(toolKey, input) {
        const generation = sessionGeneration;
        const response = (await get().sendCommand({
          type: "invoke_tool",
          toolKey,
          input,
          source: "chat",
        })) as { invokeId?: string } | undefined;

        if (!response?.invokeId) {
          const message =
            get().error?.message ?? "The page tool could not be invoked.";
          return { state: "failed", errorMessage: message };
        }

        const invokeId = response.invokeId;
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
        if (!options?.silent) {
          const result = (await get().sendCommand({
            type: "capture_screenshot",
          })) as { screenshotBase64?: string } | undefined;
          if (newest()) set({ lastScreenshot: result?.screenshotBase64 });
          return;
        }
        // The polling path, which runs once a second and must be INVISIBLE in
        // the error banner. `sendCommand` clears `error` on every success, so
        // polling through it would wipe a navigation or invocation failure
        // within a second of it appearing — usually before anyone read it.
        const sessionId = get().session?.sessionId;
        if (!sessionId) return;
        const result = await request<{ screenshotBase64?: string }>(
          `/sessions/${sessionId}/command`,
          {
            method: "POST",
            body: JSON.stringify({ type: "capture_screenshot" }),
          },
        );
        // The poll runs every second and the request outlives a close: landing
        // this write after the session changed would hang the OLD page's paint
        // in the new session's pane, where nothing would ever correct it.
        if (get().session?.sessionId !== sessionId) return;
        if (result.ok && newest()) {
          set({ lastScreenshot: result.data.screenshotBase64 });
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
