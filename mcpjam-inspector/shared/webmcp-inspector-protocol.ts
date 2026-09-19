import { BROWSER_VIEWPORT_POLICY } from "./browser-viewport-policy";
import {
  BROWSER_INPUT_BATCH_LIMIT,
  BROWSER_INPUT_TEXT_MAX_CHARS,
  type BrowserPaneInputEvent,
} from "./browser-pane-input";

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
 * third-party content. They are safe to DISPLAY and must never decide whether a
 * model-triggered invocation needs approval. A page that wants its tool run
 * without a prompt has every incentive to say `readOnly: true`, and nothing
 * checks it — so the rule is about WHO is speaking, not about how reliably we
 * hear them.
 *
 * WHAT IS ACTUALLY REPORTED, per field, measured against Chromium 151.0.7922.34
 * and asserted field by field in `webmcp-cdp.spike.test.ts`:
 *
 *   - `readOnly` and `untrustedContent` are carried through with the page's
 *     values, from the `readOnlyHint` / `untrustedContentHint` keys the page API
 *     reads. A tool that declared the BARE names instead is reported `false`,
 *     because those are not the keys Blink looks at.
 *   - `consequential` is not written at all by that build, even when the page
 *     declares `consequentialHint`. Current Chromium does copy it, so this is a
 *     fact about a version, and the spike fails when it changes.
 *   - `autosubmit` can only come from markup (`<form toolautosubmit>`); an
 *     imperative registration never carries it.
 */
export interface WebMcpToolAnnotations {
  /** "The tool does not modify any state." A page's claim — see above. */
  readOnly?: boolean;
  /** "Output may contain untrusted content, ex: UGC, 3rd party data." */
  untrustedContent?: boolean;
  /**
   * The page claims this tool may cause a consequential side effect.
   *
   * Never populated by the pinned Chromium, which does not copy
   * `consequentialHint` — so absence here is "this build does not report it",
   * not "the page said no".
   */
  consequential?: boolean;
  /** Set when a DECLARATIVE tool carried the `toolautosubmit` attribute. */
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
  /**
   * True when the registering frame is not the main frame.
   *
   * Means what it says. It used to be able to describe only a SAME-ORIGIN
   * subframe, because a cross-origin frame is a separate Chromium target whose
   * tools never reach the page's CDP session — so a page whose tools lived in a
   * third-party widget inspected as having none. The provider now attaches a
   * session per such frame, so both kinds of subframe are listed, each under
   * its own `origin`.
   */
  fromSubframe: boolean;
}

/** Identity of one observed registration, independent of its display key. */
export interface WebMcpRegistrationBinding {
  frameId: string;
  registrationSeq: number;
  /** Hosted bindings remain valid across inspector replicas, but not browser boots. */
  browser?: { bootId: string; tabId: string; navCounter: number };
}

export function sameWebMcpRegistration(
  a: WebMcpRegistrationBinding | undefined,
  b: WebMcpRegistrationBinding | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.frameId === b.frameId &&
    a.registrationSeq === b.registrationSeq &&
    a.browser?.bootId === b.browser?.bootId &&
    a.browser?.tabId === b.browser?.tabId &&
    a.browser?.navCounter === b.browser?.navCounter
  );
}

export interface WebMcpToolDescriptor extends WebMcpToolRef {
  /** Missing on older providers; such tools cannot be offered to chat. */
  binding?: WebMcpRegistrationBinding;
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
  /** Main-owned WebContentsView, placed through the existing native surface IPC. */
  | { kind: "electron-native"; bootId: string };

/**
 * Whether the SERVER paints this session's picture into the pane.
 *
 * One answer for both sides of the client: the store opens the frame socket on
 * it, and the pane asks for a stream on it. Two copies are how a pane ends up
 * requesting frames that no transport carries.
 *
 * A `native-window` or `headless` session is mirrored into the pane just as a
 * `frame-stream` one is — the difference is only whether the pane drives it.
 * `undefined` (no session yet) answers like the window arm.
 */
export function webMcpServerPaints(
  kind: WebMcpViewportTransport["kind"] | undefined,
): boolean {
  switch (kind) {
    case undefined:
    case "native-window":
    case "headless":
    case "frame-stream":
      return true;
    case "remote-interactive-url":
    case "electron-native":
      return false;
    default:
      kind satisfies never;
      return false;
  }
}

/** Retain WebMCP's existing persistent Electron profile across the ownership migration. */
export const WEBMCP_BROWSER_PARTITION = "persist:webmcp-inspector";

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
/** The inspection API vocabulary is an edge adapter over the canonical event. */
type InspectionInput<E extends BrowserPaneInputEvent> = E extends unknown
  ? Omit<E, "type" | "modifiers"> & {
      kind: E["type"];
      modifiers?: WebMcpInputModifiers;
    }
  : never;
export type WebMcpInputEvent = InspectionInput<BrowserPaneInputEvent>;

export type WebMcpMouseButton = "left" | "middle" | "right";

/** Most events a single `input` command may carry. */
export const WEBMCP_INPUT_BATCH_LIMIT = BROWSER_INPUT_BATCH_LIMIT;

/** Longest run of text one `text` event may carry. */
export const WEBMCP_INPUT_TEXT_MAX_CHARS = BROWSER_INPUT_TEXT_MAX_CHARS;

export type WebMcpCommand =
  | { type: "browser_state" }
  | {
      type: "browser_command";
      command: import("./browser-pane-command").BrowserPaneCommand;
    }
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
      expectedBinding?: WebMcpRegistrationBinding;
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
  | { type: "set_viewport"; width: number; height: number }
  /**
   * Drive the page from the pane.
   *
   * A BATCH, never a single event. Pointer movement is the flooding vector — a
   * drag across the pane produces hundreds of events a second — and batching
   * solves that at the transport rather than asking every caller to remember to
   * rate-limit. The route bounds the array, so one request can never carry an
   * unbounded amount of work.
   */
  | { type: "input"; events: WebMcpInputEvent[]; tabId?: string };

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
   * Also used for a running local call after cancellation or timeout: the
   * browser acknowledging cancellation does not prove that the page callback
   * stopped or that its side effects were undone. Verify state before retrying.
   * A hosted invocation is sent to a daemon that executes it
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
  /** Only a definite refusal before execution may request a fresh tool snapshot. */
  errorCode?: "tool-gone";
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
      /** Only a definite refusal before execution may request a fresh tool snapshot. */
      errorCode?: "tool-gone";
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
  | { type: "activity"; seq: number; entry: WebMcpActivityEntry };

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

/** The same bound as the daemon's interactive JPEG stream. */
export const WEBMCP_FRAME_MAX_BYTES = BROWSER_VIEWPORT_POLICY.maxFrameBytes;

/** Floor on the gap between published frames: 10fps. */
export const WEBMCP_FRAME_MIN_INTERVAL_MS =
  BROWSER_VIEWPORT_POLICY.minIntervalMs;

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
export const WEBMCP_FRAME_BOOST_INTERVAL_MS =
  BROWSER_VIEWPORT_POLICY.inputIntervalMs;

/**
 * How long a boost lasts after the input that caused it.
 *
 * Long enough to cover the settle of a gesture — a scroll's momentum, a page
 * reflowing after a keystroke — and short enough that an idle pane is back to
 * the resting floor about a second after the person stops.
 */
export const WEBMCP_FRAME_BOOST_WINDOW_MS =
  BROWSER_VIEWPORT_POLICY.inputBoostWindowMs;

/**
 * NO BINARY FRAME ADAPTER HERE ANY MORE.
 *
 * The inspection frame socket used to carry its own message format, which this
 * file encoded and decoded. It was already the daemon's frame-stream record
 * byte for byte — the adapter simply wrapped `encodeFrameStreamRecord` and
 * re-validated a single-record decode — so the socket now speaks that codec
 * directly (`shared/browserd-frame-stream.ts`) and the client reads it with the
 * same `createFrameWireReader` the Playground panes use. One codec, one reader,
 * one place a framing bug can live.
 */

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
  /** Absent when there is no serialized form to measure — see below. */
  bytes: number | undefined;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    // Cyclic or otherwise unserializable output from an untrusted page.
    return {
      value: "[unserializable tool output]",
      truncated: true,
      // NOT a size. There is no serialized form to measure, so any number here
      // is a fabrication — and `outputBytes` is read as "how much was dropped".
      // Zero said the result was truncated from nothing.
      bytes: undefined,
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
