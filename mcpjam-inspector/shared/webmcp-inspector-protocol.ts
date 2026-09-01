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
  | "closed";

/**
 * How the viewer sees (and drives) the browser. V1 ships `native-window` only;
 * the other two exist so adding them later is a provider change, not a protocol
 * change.
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
  | { kind: "frame-stream"; width: number; height: number };

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
 * One thing a person did to the pane, in the FRAME's device pixels.
 *
 * Coordinates are scaled on the client, because only the client knows the
 * rendered size of its pane and how the picture is letterboxed inside it. It
 * scales against the dimensions of the frame it is looking at, so the mapping
 * is exact even mid-resize.
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
  "succeeded" | "failed" | "cancelled" | "timeout";

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

/** JPEG quality for streamed frames. Legible text, roughly a tenth the bytes. */
export const WEBMCP_FRAME_QUALITY = 50;

/**
 * Hard cap on one streamed frame.
 *
 * Four times the 64 KiB budget the timeline's screenshots live under, and
 * deliberately so: a frame is TRANSIENT — it is replaced by the next paint and
 * never persisted — so the cost of a big one is one SSE write, not a permanent
 * entry in an export. An oversized frame is DROPPED rather than re-encoded in
 * the hot path; the provider converges the pane by publishing one budgeted
 * screenshot instead, so a page whose final paint never fits still stops being
 * stale.
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
 *   6       u16   reserved (0)
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
  view.setUint16(6, 0, true);
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
  return {
    deviceWidth: view.getUint16(2, true),
    deviceHeight: view.getUint16(4, true),
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
