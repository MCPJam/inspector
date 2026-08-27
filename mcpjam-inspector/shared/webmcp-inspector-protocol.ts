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
  | { kind: "frame-stream" };

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
  | { type: "capture_screenshot" };

export type WebMcpCommandResult =
  | { ok: true }
  | { ok: true; invokeId: string }
  | { ok: true; cancelled: boolean }
  | { ok: true; screenshotBase64?: string };

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

export const WEBMCP_VIEWPORT = { width: 1280, height: 800 } as const;

/** Marker appended to a truncated string result. */
export function truncationMarker(totalBytes: number): string {
  return `\n…[truncated: ${totalBytes} bytes total]`;
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
  const head = Buffer.from(serialized, "utf8")
    .subarray(0, WEBMCP_RESULT_CAP_BYTES)
    .toString("utf8");
  return { value: head + truncationMarker(bytes), truncated: true, bytes };
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
  const head = Buffer.from(serialized, "utf8")
    .subarray(0, WEBMCP_INPUT_ECHO_CAP_BYTES)
    .toString("utf8");
  return { value: head + truncationMarker(bytes), truncated: true };
}
