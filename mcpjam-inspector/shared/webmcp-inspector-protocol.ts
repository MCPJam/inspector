/**
 * Wire contract between the WebMCP Inspector's client surface and its server
 * session service.
 *
 * TRANSPORT-AGNOSTIC ON PURPOSE. V1 carries events over SSE and commands over
 * HTTP POST, which is what the rest of this codebase does and what a
 * single-process local inspector needs. The hosted stage will put the same
 * messages on a WebSocket and a later provider will run the browser somewhere
 * else entirely; none of that should require re-deriving the message shapes,
 * so nothing here mentions SSE, POST, or Playwright.
 *
 * `viewportTransport` is the seam for that move: V1 always reports
 * `native-window` (the browser opens on the developer's own machine and they
 * drive it directly), while a remote provider reports an interactive URL and a
 * frame-streaming provider reports `frame-stream`. The client renders whichever
 * it is handed, so adding a transport does not change this file's consumers.
 */

/**
 * Tool annotations, mirroring the CDP `WebMCP.Annotation` type exactly.
 *
 * TRUST BOUNDARY: these are claims made by the inspected page, which is
 * third-party content. They are safe to DISPLAY and must never decide whether
 * a model-triggered invocation needs approval. Beyond the usual "annotations
 * are hints" caveat, Chromium 151 does not even plumb the values through for
 * imperative registrations — a tool registered with `readOnly: true` is
 * reported here as `false` (asserted in `webmcp-cdp.spike.test.ts`). So an
 * absent or false `readOnly` says nothing at all about the tool.
 */
export interface WebMcpToolAnnotations {
  /** "The tool does not modify any state." Advisory only — see above. */
  readOnly?: boolean;
  /** "Output may contain untrusted content, ex: UGC, 3rd party data." */
  untrustedContent?: boolean;
  /** The page claims this tool may cause a consequential side effect. */
  consequential?: boolean;
  /** Set when a DECLARATIVE tool carried the autosubmit attribute. */
  autosubmit?: boolean;
}

/** Identity of a tool, as the user and the model see it. */
export interface WebMcpToolRef {
  /**
   * Stable, human-readable key: `${origin}::${name}`, with a `#<4hex>` suffix
   * when two frames of the same origin register the same name. Stable across
   * navigations and reconnects, unlike the CDP frameId, which is resolved at
   * invoke time instead.
   */
  toolKey: string;
  /** The name the page registered, and the name used to invoke it. */
  name: string;
  /** Origin of the frame that registered it, at registration time. */
  origin: string;
  /** True when the registering frame is not the main frame. */
  fromSubframe: boolean;
}

export interface WebMcpToolDescriptor extends WebMcpToolRef {
  description: string;
  /** JSON Schema for the tool's input, as published by the page. */
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  /**
   * How the page registered this tool. Declarative tools come from markup and
   * carry a DOM node; imperative ones come from a `registerTool` call and carry
   * a stack trace. Provenance is worth showing: it tells a developer which of
   * their two registration paths produced the tool.
   */
  registrationKind: "declarative" | "imperative" | "unknown";
}

export type WebMcpSessionStatus =
  | "starting"
  | "ready"
  | "navigating"
  /** The browser has no WebMCP support; the page loaded but nothing can be inspected. */
  | "unsupported"
  | "error"
  /**
   * This server let go of a REMOTE browser that is still running.
   *
   * Only hosted sessions reach this. The browser lives on the member's own
   * computer, so a replica dropping its handle — idle eviction, a deploy, a
   * request routed elsewhere — ends nothing; the session can be picked up
   * again by asking for it. Distinct from `closed` precisely because `closed`
   * is terminal, and telling someone their live browser had ended when it had
   * not is the failure this exists to prevent. The client re-fetches.
   */
  | "detached"
  | "closed";

/**
 * How the viewer sees (and drives) the browser.
 *
 * Adding a kind here is a PROVIDER change, never a consumer change — which
 * only holds if consumers branch exhaustively. The client does (see
 * `viewportBehaviour` in `WebmcpInspectorTab.tsx`, whose `satisfies never`
 * makes the next addition a compile error rather than a silent fall-through to
 * "a browser window is open on this machine").
 */
export type WebMcpViewportTransport =
  /** A real window on the viewer's own machine; they drive it directly. */
  | { kind: "native-window" }
  /** No viewport at all: the browser is headless, so tools only. */
  | { kind: "headless" }
  | { kind: "remote-interactive-url"; url: string }
  /**
   * The page is streamed here as frames, and driven from here as input.
   *
   * Carries the surface's dimensions so the client can lay out (and letterbox)
   * its pane BEFORE the first frame arrives. Waiting for a frame to learn the
   * aspect ratio means the pane resizes under the viewer a moment after it
   * appears, and any click landing in that moment is scaled against the wrong
   * box.
   */
  | { kind: "frame-stream"; width: number; height: number }
  /**
   * A REAL Chromium surface, embedded in the desktop app, that the CLIENT owns.
   *
   * The inversion is the whole point. Every other kind describes a browser the
   * server started and the client observes; this one describes a browser the
   * client mounted and the server merely ATTACHED to. So it carries no
   * dimensions (the element is laid out by CSS and resizes with the window), it
   * is never screencast (there is nothing to encode — the pixels are already
   * on the viewer's screen), and it is never driven by forwarded input (the
   * surface receives the viewer's real mouse and keyboard natively). A client
   * that treated it like `frame-stream` would ask for an encoder nobody reads
   * and deliver every click twice.
   */
  | { kind: "electron-webview" };

/**
 * The Electron session partition every embedded WebMCP surface runs in.
 *
 * Named here, in the file both halves already import, because it is enforced
 * at THREE points that must agree exactly: the client's `<webview partition>`
 * attribute, the main process's `will-attach-webview` guard, and the server
 * provider's check that the `webContents` it was handed is really one of ours.
 * Three string literals would drift; one constant cannot.
 *
 * `persist:` on purpose — the local inspector's stance everywhere else is a
 * persistent profile, because a developer inspecting their own site should not
 * have to sign in again on every session.
 */
export const WEBMCP_WEBVIEW_PARTITION = "persist:webmcp-inspector";

export interface WebMcpSessionPublic {
  sessionId: string;
  status: WebMcpSessionStatus;
  /** Current main-frame URL. */
  url: string;
  createdAt: number;
  /** When the idle timer would reap this session; refreshed by activity. */
  expiresAt: number;
  /** Hard stop, regardless of activity. */
  hardExpiresAt: number;
  viewportTransport: WebMcpViewportTransport;
  /**
   * JPEG quality the viewport stream is currently encoding at, when the
   * provider has an adaptive one.
   *
   * Reported so the picture getting worse is a fact the UI can show rather
   * than a mystery the viewer has to guess at — "the link is struggling" and
   * "the page is broken" look identical otherwise. Absent for a provider whose
   * stream is not adaptive, and for every server older than the field.
   */
  streamQuality?: number;
  protocolVersion: typeof WEBMCP_INSPECTOR_PROTOCOL_VERSION;
  /** Present when status is `unsupported` or `error`. */
  detail?: string;
}

export const WEBMCP_INSPECTOR_PROTOCOL_VERSION = 1 as const;

/** Where an invocation came from. Both share one queue and one timeline. */
export type WebMcpInvocationSource = "manual" | "chat";

/**
 * A modifier's state at the moment an event was produced.
 *
 * Sent per event rather than tracked server-side: the pane can lose focus
 * mid-gesture (an alt-tab between keydown and keyup), and a server holding its
 * own idea of "shift is down" would then apply it to every later click with
 * nothing to correct it.
 */
export interface WebMcpInputModifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * One thing a person did to the pane, in the page's CSS pixels.
 *
 * Coordinates are scaled on the client, because only the client knows the
 * rendered size of its pane and how the picture is letterboxed inside it. It
 * scales against the dimensions of the frame it is looking at — DIVIDED by
 * that frame's {@link WebMcpFrame.scale}, so a frame captured at two device
 * pixels per CSS pixel still maps onto the coordinate space the page itself
 * uses. CSS pixels rather than device pixels is what keeps a session whose
 * frames arrive at more than one scale from dispatching half its clicks at
 * double coordinates.
 */
export type WebMcpInputEvent =
  | {
      kind: "mouse_move";
      x: number;
      y: number;
      modifiers?: WebMcpInputModifiers;
    }
  | {
      kind: "mouse_down";
      x: number;
      y: number;
      button: WebMcpMouseButton;
      clickCount?: number;
      modifiers?: WebMcpInputModifiers;
    }
  | {
      kind: "mouse_up";
      x: number;
      y: number;
      button: WebMcpMouseButton;
      clickCount?: number;
      modifiers?: WebMcpInputModifiers;
    }
  | {
      kind: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: WebMcpInputModifiers;
    }
  | { kind: "key_down"; key: string; modifiers?: WebMcpInputModifiers }
  | { kind: "key_up"; key: string; modifiers?: WebMcpInputModifiers }
  /**
   * Text as the person actually produced it, not a key sequence.
   *
   * Its own event because paste and IME composition have no keystrokes to
   * replay: reconstructing "日本語" or a pasted paragraph as key events would
   * be wrong in a different way on every keyboard layout.
   */
  | { kind: "text"; text: string };

export type WebMcpMouseButton = "left" | "middle" | "right";

/** Most events a single `input` command may carry. */
export const WEBMCP_INPUT_BATCH_LIMIT = 64;

/** Longest run of text one `text` event may carry. */
export const WEBMCP_INPUT_TEXT_MAX_CHARS = 4 * 1024;

export type WebMcpCommand =
  | { type: "navigate"; url: string }
  | { type: "reload" }
  | { type: "go_back" }
  | {
      type: "invoke_tool";
      /**
       * The CALLER's id for this invocation, making the call idempotent.
       *
       * Optional so every existing client keeps working — omitted, the server
       * issues one, exactly as before. A client that can be retried sends it:
       * a hosted request may be dropped in flight or land on a different
       * replica, and the id is what lets the second attempt be recognised as
       * the same invocation instead of running a side-effecting page tool
       * twice.
       */
      invokeId?: string;
      toolKey: string;
      input: Record<string, unknown>;
      source: WebMcpInvocationSource;
    }
  | { type: "cancel_invocation"; invokeId: string }
  | { type: "capture_screenshot" }
  /**
   * Turn the viewport stream on or off. DEMAND-DRIVEN on purpose: a page
   * nobody is looking at should not be encoding JPEGs, so the client asks for
   * frames when its pane is visible and stops asking when it is not.
   */
  | { type: "set_screencast"; enabled: boolean }
  /**
   * Drive the page from the pane.
   *
   * A BATCH, never a single event. Pointer movement is the flooding vector — a
   * drag across the pane produces hundreds of events a second — and batching
   * solves that at the transport rather than asking every caller to remember to
   * rate-limit. The route bounds the array, so one request can never carry an
   * unbounded amount of work.
   */
  | { type: "input"; events: WebMcpInputEvent[] };

export type WebMcpCommandResult =
  | { ok: true }
  | { ok: true; invokeId: string }
  | { ok: true; cancelled: boolean }
  | { ok: true; screenshotBase64?: string }
  /** `set_screencast`: whether frames are actually flowing now. */
  | { ok: true; streaming: boolean };

/** Terminal state of an invocation, ours rather than CDP's. */
export type WebMcpInvocationState =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout"
  /**
   * It ran, and what it did cannot be established.
   *
   * Reachable only for a REMOTE browser, and it is the honest answer rather
   * than a hedge. A hosted invocation is sent to a daemon that executes it
   * synchronously; if our wait for the answer ends first — the request was
   * aborted, the replica went away — the tool keeps running and its outcome
   * lands in the daemon's result cache, addressed by the invocation's id.
   * Until someone asks again with that id, "succeeded" and "failed" are both
   * guesses, and a page tool that may have charged a card is not something to
   * guess about or to re-run to find out.
   */
  | "unknown";

/**
 * A hosted session's id is DERIVED, not issued.
 *
 * `hosted:<projectId>:<computerId>` — because there is exactly one persistent
 * browser per desktop computer, so there is exactly one inspector session for
 * it, and any replica can name it without having been the one to create it.
 * That is the whole mechanism behind surviving a hosted deploy: a request that
 * lands on a replica which has never seen this session can still work out what
 * it refers to and re-establish it, rather than 404ing because the process
 * that held the map is not the one that got the request.
 *
 * Shared rather than server-only because the CLIENT reads it too: the browser
 * panel embedded in the inspector must authorize against the project the
 * SESSION is running on, and the session id is the only place that says so.
 */
export function hostedSessionId(projectId: string, computerId: string): string {
  return `hosted:${projectId}:${computerId}`;
}

export function parseHostedSessionId(
  sessionId: string | undefined,
): { projectId: string; computerId: string } | null {
  if (!sessionId?.startsWith("hosted:")) return null;
  const [, projectId, computerId, ...rest] = sessionId.split(":");
  if (!projectId || !computerId || rest.length > 0) return null;
  return { projectId, computerId };
}

/**
 * How an invocation finished, as one value.
 *
 * There are TWO ways a caller learns an invocation's fate and they must agree
 * field for field. Locally the settle arrives on the activity stream, as an
 * `invocation_settled` entry. Hosted it comes back INLINE on the invoke
 * response, because the subscriber watching that stream may be attached to a
 * different replica than the one that ran the tool.
 *
 * Naming them separately is how they drift: the inline arm shipped carrying
 * `error` where the stream arm carries `errorMessage`, and carrying no output
 * at all — so a hosted page tool answered a model with `null` and a hosted
 * failure answered it with nothing. One type, used by both.
 */
export interface WebMcpInvocationOutcome {
  state: WebMcpInvocationState;
  /** Only on `succeeded`, and only up to the result cap. */
  output?: unknown;
  outputTruncated?: boolean;
  /** Total bytes before truncation, so the UI can say what was dropped. */
  outputBytes?: number;
  errorMessage?: string;
}

export type WebMcpActivityEntry =
  | { id: string; ts: number; kind: "session_started"; url: string }
  | { id: string; ts: number; kind: "navigated"; url: string; origin: string }
  | {
      id: string;
      ts: number;
      kind: "popup_opened";
      url: string;
      /**
       * Popups are left alone: closing one or folding it into the main tab
       * breaks OAuth and `window.opener` flows. Their tools are not inspected
       * in V1 — a popup is a separate target.
       */
      note: string;
    }
  | { id: string; ts: number; kind: "tools_added"; tools: WebMcpToolRef[] }
  | {
      id: string;
      ts: number;
      kind: "tools_removed";
      tools: WebMcpToolRef[];
      /** `page` when synthesized on navigation, `page_signal` when the page said so. */
      cause: "page" | "page_signal";
    }
  | {
      id: string;
      ts: number;
      kind: "invocation_started";
      invokeId: string;
      toolKey: string;
      source: WebMcpInvocationSource;
      input: unknown;
      inputTruncated?: boolean;
      screenshotBase64?: string;
    }
  | {
      id: string;
      ts: number;
      kind: "invocation_settled";
      invokeId: string;
      toolKey: string;
      source: WebMcpInvocationSource;
      state: WebMcpInvocationState;
      durationMs: number;
      /** Only on `succeeded`, and only up to the result cap. */
      output?: unknown;
      outputTruncated?: boolean;
      /** Total bytes before truncation, so the UI can say what was dropped. */
      outputBytes?: number;
      errorMessage?: string;
      screenshotBase64?: string;
    }
  | {
      id: string;
      ts: number;
      kind: "external_invocation";
      toolKey?: string;
      note: string;
    }
  | { id: string; ts: number; kind: "session_error"; message: string }
  | { id: string; ts: number; kind: "unsupported"; message: string };

/**
 * One painted frame of the inspected page, for the `frame-stream` viewport.
 *
 * TRANSIENT, and deliberately not an activity entry. Frames never enter the
 * replay ring, never appear in an export, and carry no history worth keeping:
 * the only interesting frame is the current one. That is also why they are
 * distinct from the `screenshotBase64` on an invocation entry, which is
 * PERSISTED EVIDENCE at a much smaller budget — a frame may even predate the
 * settle it appears beside, because coalescing keeps the last *paint* rather
 * than the paint at any particular moment. Never source one from the other.
 *
 * The device dimensions ride on every frame rather than being read from
 * {@link WEBMCP_VIEWPORT}: the client scales pointer coordinates against them,
 * and a frame whose dimensions came from somewhere other than the frame itself
 * would put clicks in the wrong place the moment the two disagreed.
 */
export interface WebMcpFrame {
  /** Base64 JPEG, capped at {@link WEBMCP_FRAME_MAX_BYTES}. */
  data: string;
  /** Width of the captured surface, in device pixels. */
  deviceWidth: number;
  /** Height of the captured surface, in device pixels. */
  deviceHeight: number;
  /** Wall-clock capture time. */
  ts: number;
  /**
   * Device pixels per CSS pixel in THIS frame. Absent means 1.
   *
   * The frame's dimensions are physical; everything a person points at is in
   * CSS pixels, and the two stop being the same number the moment a session
   * captures at a device pixel ratio above 1. Carried per frame rather than per
   * session because a session's frames need not agree: a still captured at full
   * device resolution can arrive between two streamed frames captured at CSS
   * resolution, and a client that assumed one ratio for the session would put
   * clicks in the wrong place for the other.
   *
   * Optional so an older server's frames — which have no notion of this — read
   * as the 1 they have always implicitly been.
   */
  scale?: number;
}

export type WebMcpEvent =
  | { type: "session"; seq: number; session: WebMcpSessionPublic }
  /**
   * ALWAYS the full current registry, never a delta. A reconnecting client that
   * replayed deltas would have to reason about what it missed; a snapshot is
   * correct on arrival no matter what it missed.
   */
  | { type: "tools"; seq: number; tools: WebMcpToolDescriptor[] }
  | { type: "activity"; seq: number; entry: WebMcpActivityEntry }
  /**
   * Coalesced, not queued: the hub keeps ONE of these per session and replaces
   * it, so a page animating at 10fps cannot flush the activity ring. `seq` is
   * still stamped from the session's own counter so a replayed frame sorts into
   * place beside the events around it.
   */
  | { type: "frame"; seq: number; frame: WebMcpFrame };

/**
 * Cap on a result, both for what we persist in the timeline and what a model
 * may see. Chromium hands the full payload over regardless of size (a 300 KB
 * result arrives intact), so this cap is entirely ours to enforce.
 */
export const WEBMCP_RESULT_CAP_BYTES = 256 * 1024;

/** Cap on the echoed input in an `invocation_started` entry. */
export const WEBMCP_INPUT_ECHO_CAP_BYTES = 16 * 1024;

/** Default per-invocation timeout. A page tool that hangs must not hang us. */
export const WEBMCP_INVOKE_TIMEOUT_MS = 60_000;

/** How many invocations may wait behind the running one before we refuse. */
export const WEBMCP_INVOKE_QUEUE_LIMIT = 5;

/** Events retained per session for replay to a (re)connecting client. */
export const WEBMCP_ACTIVITY_RING_SIZE = 200;

/** Defensive bounds for registry snapshots emitted by an inspected page. */
export const WEBMCP_TOOL_MAX_ENTRIES = 64;
export const WEBMCP_TOOL_NAME_MAX_CHARS = 128;
export const WEBMCP_TOOL_DESCRIPTION_MAX_CHARS = 512;
export const WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES = 8 * 1024;

export const WEBMCP_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * JPEG quality rungs for the streamed frames themselves, best first.
 *
 * Index 0 is the BASELINE every stream starts at. 75 rather than the 50 this
 * ladder replaces because the artefact people actually notice is mosquito
 * noise around text: at q50 a paragraph of 14px body copy is legible but
 * visibly dirty, and the whole picture is being resampled by the pane on top
 * of that. The lower rungs exist for a link that cannot carry the baseline,
 * and the governor — not this file — decides when to walk down them.
 */
export const WEBMCP_STREAM_QUALITY_LADDER = [75, 60, 45, 30] as const;

/**
 * Qualities tried for the still that replaces an OVERSIZE frame.
 *
 * Deliberately below the stream's baseline: this still exists because the
 * page's own paint did not fit the cap, so trying to publish it at the same
 * quality would mostly reproduce the same failure a round trip later.
 *
 * The bottom rung is ugly on purpose. It is only ever reached by a page whose
 * paint will not fit at 25 — near-maximum-entropy content, a noise canvas or a
 * grain-heavy photo filling the viewport — and for THAT page the choice is not
 * between a good picture and a poor one. It is between a poor picture of the
 * page it is looking at and a sharp picture of a page it has left, because the
 * frame itself was refused for its size and a page that has stopped painting
 * sends nothing else. Frames are transient; the next paint replaces this.
 *
 * It narrows the gap rather than closing it: a paint that will not fit at 10
 * still publishes nothing. Closing it needs a proportional resize, which CDP
 * offers only through `clip` — measured to clobber the context's
 * `deviceScaleFactor` and push an off-content frame into the stream.
 */
export const WEBMCP_SUBSTITUTE_QUALITY_LADDER = [50, 25, 10] as const;

/**
 * Qualities tried for the SETTLE still — the sharp picture published once a
 * page has stopped painting.
 *
 * ABOVE the stream's baseline, which is the entire point. Motion hides
 * compression artefacts and a still page does not: the frame a person actually
 * reads is the one that is still on screen a second after they stopped
 * scrolling, and that one can afford bytes the 10fps stream cannot.
 */
export const WEBMCP_SETTLE_STILL_QUALITIES = [
  85,
  // The floor is the STREAM's own baseline, never below it: this still exists
  // to improve on the picture already on screen, and publishing a worse one
  // because the good one did not fit would be a downgrade dressed up as a
  // feature. When neither rung fits, nothing is published and the pane keeps
  // what it has.
  75,
] as const;

/**
 * How long a page must go without painting (or being driven) before the sharp
 * still is taken.
 *
 * Long enough that a scroll's momentum, a hover transition or a page reflow
 * does not spend a capture; short enough that "stopped scrolling" and "the
 * text sharpened" feel like the same moment.
 */
export const WEBMCP_SETTLE_QUIET_MS = 800;

/**
 * Cadence of the provider's housekeeping timer, which is what notices the
 * quiet window has passed.
 *
 * A timer rather than a per-frame `setTimeout`, because the interesting case is
 * the ABSENCE of frames — there is no event to hang a deadline off. 250ms puts
 * at most a quarter-second of slop on {@link WEBMCP_SETTLE_QUIET_MS} while
 * costing four wakeups a second on an idle session.
 */
export const WEBMCP_HOUSEKEEPING_INTERVAL_MS = 250;

/**
 * How far back the governor looks for evidence that the link cannot carry the
 * stream.
 *
 * One dropped frame is not evidence: the pacer holds the newest frame while a
 * send is outstanding, and a single overwrite happens on any link the moment
 * two paints land inside one round trip. A RUN of them inside a couple of
 * seconds is a consumer that is not keeping up.
 */
export const WEBMCP_QUALITY_PRESSURE_WINDOW_MS = 2_000;

/** Drops inside that window before the stream steps down a rung. */
export const WEBMCP_QUALITY_PRESSURE_DROPS = 3;

/**
 * How long a rung is held before the governor may move again.
 *
 * A step costs a stop/start of the encoder, and the frames already in flight
 * when it lands are still the old size — so a governor without a hold would
 * read its own transition as more pressure and walk to the bottom of the
 * ladder in one burst.
 */
export const WEBMCP_QUALITY_STEP_HOLD_MS = 3_000;

/**
 * How long the link must be free of drops before quality climbs back.
 *
 * Deliberately much longer than the step-down window. Stepping down is a
 * response to something a person is watching happen; stepping up is an
 * experiment, and an experiment that fails costs them another stall.
 */
export const WEBMCP_QUALITY_RECOVER_QUIET_MS = 10_000;

/**
 * Hard cap on one streamed frame.
 *
 * Four times the 64 KiB budget the timeline's screenshots live under, and
 * deliberately so: a frame is TRANSIENT — it is replaced by the next paint and
 * never persisted — so the cost of a big one is one SSE write, not a permanent
 * entry in an export. An oversized frame is DROPPED rather than re-encoded in
 * the hot path; the provider converges the pane by publishing one budgeted
 * STILL instead (see {@link WEBMCP_SUBSTITUTE_QUALITY_LADDER}), so a page whose
 * final paint never fits still stops being stale.
 */
export const WEBMCP_FRAME_MAX_BYTES = 256 * 1024;

/** Floor on the gap between published frames: 10fps. */
export const WEBMCP_FRAME_MIN_INTERVAL_MS = 100;

/**
 * Floor while someone is actively driving the pane: ~30fps.
 *
 * The resting floor is deliberately slow — a page nobody is touching does not
 * need 30 JPEGs a second, and most of what a screencast paints is a spinner.
 * But the moment a person scrolls or types, the interesting frame is the one
 * echoing what they just did, and a 100ms floor puts up to a tenth of a second
 * between the two on its own. So the rate is raised by INPUT rather than
 * configured: the cost is paid exactly while it buys something.
 */
export const WEBMCP_FRAME_BOOST_INTERVAL_MS = 33;

/**
 * How long a boost lasts after the input that caused it.
 *
 * Long enough to cover the settle of a gesture — a scroll's momentum, a page
 * reflowing after a keystroke — and short enough that an idle pane is back to
 * the resting floor about a second after the person stops.
 */
export const WEBMCP_FRAME_BOOST_WINDOW_MS = 1_500;

/**
 * Size of the fixed header on a binary frame message. See
 * {@link encodeWebMcpBinaryFrame}.
 */
export const WEBMCP_FRAME_WS_HEADER_BYTES = 24;

/** Current version byte of the binary frame wire format. */
const WEBMCP_FRAME_WIRE_VERSION = 1;
/** Message kind: a painted JPEG frame. The only kind V1 defines. */
const WEBMCP_FRAME_WIRE_KIND_JPEG = 1;

/** A frame as it travels on the binary wire, and as `decode` hands it back. */
export interface WebMcpBinaryFrame {
  deviceWidth: number;
  deviceHeight: number;
  /** Device pixels per CSS pixel; see {@link WebMcpFrame.scale}. */
  scale?: number;
  /** Wall-clock capture time, from the publishing server. */
  ts: number;
  /** The session's monotonic event counter, shared with the SSE stream. */
  seq: number;
  /** Raw JPEG bytes — NOT base64. */
  jpeg: Uint8Array;
}

/**
 * Pack one frame as a single binary message: a fixed 24-byte little-endian
 * header followed by the JPEG bytes.
 *
 *   offset  type  field
 *   0       u8    version (1)
 *   1       u8    kind (1 = JPEG)
 *   2       u16   deviceWidth
 *   4       u16   deviceHeight
 *   6       u16   scale x 1000 (0 = 1.0)
 *   8       f64   ts
 *   16      u32   seq
 *   20      u32   jpegByteLength
 *   24      …     JPEG bytes
 *
 * ONE message per frame rather than a meta/payload pair: a pair needs pairing
 * state on the receiver — and a receiver that loses track of which half it is
 * holding paints one frame's pixels with another frame's dimensions, which is
 * exactly the bug that puts every click in the wrong place. One atomic message
 * also halves the message count on a 30fps stream.
 *
 * `DataView` and `Uint8Array` only, no `Buffer`: this runs in the browser on
 * the decode side, and one file compiled for both ends is the only way the two
 * cannot drift.
 */
export function encodeWebMcpBinaryFrame(frame: WebMcpBinaryFrame): Uint8Array {
  const out = new Uint8Array(WEBMCP_FRAME_WS_HEADER_BYTES + frame.jpeg.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, WEBMCP_FRAME_WIRE_VERSION);
  view.setUint8(1, WEBMCP_FRAME_WIRE_KIND_JPEG);
  // Clamped rather than trusted: a surface reported larger than a u16 would
  // wrap to a small number and letterbox every later click against a box the
  // page never had.
  view.setUint16(2, clampU16(frame.deviceWidth), true);
  view.setUint16(4, clampU16(frame.deviceHeight), true);
  // Fixed point in the byte pair V1 reserved, so this is an ADDITIVE change:
  // an old decoder reads the two bytes it always ignored, and a new decoder
  // reads an old server's 0 as the 1.0 it means.
  view.setUint16(6, clampU16(Math.round((frame.scale ?? 1) * 1_000)), true);
  view.setFloat64(8, frame.ts, true);
  view.setUint32(16, frame.seq >>> 0, true);
  view.setUint32(20, frame.jpeg.length, true);
  out.set(frame.jpeg, WEBMCP_FRAME_WS_HEADER_BYTES);
  return out;
}

function clampU16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0xffff, Math.round(value)));
}

/**
 * Unpack a binary frame message, or `undefined` if it is not one.
 *
 * NEVER THROWS on wire data. This decodes bytes that arrived over a socket,
 * and the one thing worse than a dropped frame is a throw inside a `message`
 * handler taking the whole stream down with it. An unknown version or kind
 * reads as "not a frame I understand" rather than an error — which is what
 * makes adding a second kind later a non-breaking change for THIS client.
 */
export function decodeWebMcpBinaryFrame(
  buffer: ArrayBuffer | Uint8Array,
): WebMcpBinaryFrame | undefined {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < WEBMCP_FRAME_WS_HEADER_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== WEBMCP_FRAME_WIRE_VERSION) return undefined;
  if (view.getUint8(1) !== WEBMCP_FRAME_WIRE_KIND_JPEG) return undefined;
  const jpegLength = view.getUint32(20, true);
  // The declared length must match what actually arrived. A truncated message
  // would otherwise hand an `<img>` half a JPEG, which decodes to nothing and
  // leaves the pane blank with no way to tell why.
  if (jpegLength !== bytes.byteLength - WEBMCP_FRAME_WS_HEADER_BYTES) {
    return undefined;
  }
  // Zero pixels is not a frame. A bare header passes the check above — its
  // declared length of nothing does match the nothing that arrived — and the
  // presenter would then hand an `<img>` a 0-byte blob URL, which fails to
  // decode and blanks the pane with exactly the silence the check above
  // exists to prevent. Rejected HERE, at the one boundary where wire data is
  // validated, rather than guarded again at every consumer.
  if (jpegLength === 0) return undefined;
  const scaleMilli = view.getUint16(6, true);
  return {
    deviceWidth: view.getUint16(2, true),
    deviceHeight: view.getUint16(4, true),
    // Zero is what every server older than this field writes, and what
    // `encodeWebMcpBinaryFrame` wrote as "reserved" — it means 1, not a frame
    // of zero size.
    scale: scaleMilli === 0 ? 1 : scaleMilli / 1_000,
    ts: view.getFloat64(8, true),
    seq: view.getUint32(16, true),
    // A copy, not a view onto the socket's buffer: the caller holds this while
    // it decodes, and some transports reuse the underlying allocation.
    //
    // `new Uint8Array(subarray)` rather than `.slice()`, because a Node
    // `Buffer` IS a `Uint8Array` and overrides `slice` to return a VIEW — so
    // the one input where aliasing actually bites (a `ws` receive buffer) is
    // exactly the one `.slice()` fails to copy.
    jpeg: new Uint8Array(bytes.subarray(WEBMCP_FRAME_WS_HEADER_BYTES)),
  };
}

/** Marker appended to a truncated string result. */
export function truncationMarker(totalBytes: number): string {
  return `\n…[truncated: ${totalBytes} bytes total]`;
}

/**
 * Cut serialized text so the result — INCLUDING the appended marker — fits the
 * cap, and so the cut lands on a character boundary.
 *
 * Both matter. Reserving no room for the marker means "capped" output that
 * still exceeds the cap, which defeats the point of having one. And slicing a
 * UTF-8 buffer at an arbitrary byte can split a multi-byte character, leaving a
 * replacement character at the end of every truncated non-ASCII result.
 */
function cutToCap(serialized: string, cap: number, totalBytes: number): string {
  const marker = truncationMarker(totalBytes);
  const room = Math.max(0, cap - Buffer.byteLength(marker, "utf8"));
  const buffer = Buffer.from(serialized, "utf8");
  let end = Math.min(room, buffer.length);
  // Walk back off any continuation byte (0b10xxxxxx) so the slice ends on a
  // whole character.
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return buffer.subarray(0, end).toString("utf8") + marker;
}

/**
 * Truncate a tool result to the cap.
 *
 * Serializes once and measures the serialized form, because that is what both
 * the transport and the model actually carry — a small-looking object can
 * serialize to megabytes. Oversized results are replaced by their truncated
 * TEXT rather than a structurally-clipped object: half an object is a shape no
 * consumer expects, whereas clearly-marked truncated text is.
 */
export function capResult(value: unknown): {
  value: unknown;
  truncated: boolean;
  bytes: number;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    // Cyclic or otherwise unserializable output from an untrusted page.
    return {
      value: "[unserializable tool output]",
      truncated: true,
      bytes: 0,
    };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= WEBMCP_RESULT_CAP_BYTES) {
    return { value, truncated: false, bytes };
  }
  return {
    value: cutToCap(serialized, WEBMCP_RESULT_CAP_BYTES, bytes),
    truncated: true,
    bytes,
  };
}

/** Same policy as {@link capResult}, at the smaller input-echo cap. */
export function capInputEcho(value: unknown): {
  value: unknown;
  truncated: boolean;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return { value: "[unserializable tool input]", truncated: true };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= WEBMCP_INPUT_ECHO_CAP_BYTES) return { value, truncated: false };
  return {
    value: cutToCap(serialized, WEBMCP_INPUT_ECHO_CAP_BYTES, bytes),
    truncated: true,
  };
}
