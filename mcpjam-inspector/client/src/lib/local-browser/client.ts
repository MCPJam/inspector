/**
 * The Playground rail's half of the local agent browser.
 *
 * Everything here talks to `/api/mcp/computers/local-browser/*` and the frames
 * socket beside it. The server owns every decision that matters — who may
 * watch, who may type, whether a browser exists at all — so this file is
 * deliberately thin: it presents the consent capability, mints the single-use
 * nonce the socket needs, and converts DOM events into the browser's
 * coordinate space.
 */
import { authFetch } from "@/lib/session-token";
import { LOCAL_CONSENT_HEADER } from "@/lib/local-computer-consent";

/**
 * Refuse to hand the device-consent capability to a page that is not on this
 * machine and not encrypted.
 *
 * These routes exist only on a local inspector, but "local" is a property of
 * the SERVER; the page can be served from anywhere, and the consent token and
 * every keystroke this pane forwards would then cross a plaintext hop that
 * anyone on the path can read. `https:` is fine wherever it is served from,
 * loopback is fine unencrypted, and nothing else is.
 */
export class InsecureLocalBrowserOriginError extends Error {
  constructor(origin: string) {
    super(
      `The local browser will not send its consent token over ${origin}. ` +
        "Open the inspector on localhost, or over https.",
    );
    this.name = "InsecureLocalBrowserOriginError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isSecureLocalOrigin(location: {
  protocol: string;
  hostname: string;
}): boolean {
  if (location.protocol === "https:") return true;
  return LOOPBACK_HOSTS.has(location.hostname);
}

function assertSecureLocalOrigin(): void {
  if (typeof window === "undefined") return;
  if (isSecureLocalOrigin(window.location)) return;
  throw new InsecureLocalBrowserOriginError(window.location.origin);
}

/** What the pane knows about this machine's browser. */
export interface LocalBrowserStatus {
  installed: boolean;
  install: { status: "idle" | "installing" | "ready" | "failed"; percent?: number; error?: string };
  running: boolean;
  leaseHeld: boolean;
}

export interface LocalBrowserLease {
  state: "free" | "held" | "parked";
  holder?: string;
  holderKind?: "human" | "script";
  expiresAt?: number;
}

export interface LocalBrowserSession {
  bootId: string;
  contextMode: "persistent" | "ephemeral";
  lease: LocalBrowserLease;
}

/**
 * The most events one input request may carry.
 *
 * Mirrors `INPUT_BATCH_LIMIT` in `routes/mcp/computers.ts`, which slices
 * anything longer. Kept in step by hand — the client cannot import a server
 * module — and pinned by a test on each side.
 */
export const INPUT_BATCH_LIMIT = 64;

/** A pointer or key event, in the browser's own CSS-pixel space. */
export type LocalBrowserInputEvent =
  | { type: "mouse_move"; x: number; y: number; modifiers?: number }
  | {
      type: "mouse_down" | "mouse_up";
      x: number;
      y: number;
      button: "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: number;
    }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: "key_down" | "key_up"; key: string; code?: string; modifiers?: number }
  | { type: "text"; text: string };

async function post<T>(
  path: string,
  body: unknown,
  consentToken: string | null,
  options?: { keepalive?: boolean },
): Promise<T> {
  assertSecureLocalOrigin();
  const response = await authFetch(`/api/mcp/computers/local-browser/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(consentToken ? { [LOCAL_CONSENT_HEADER]: consentToken } : {}),
    },
    body: JSON.stringify(body),
    ...(options?.keepalive ? { keepalive: true } : {}),
  });
  const json = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(
      typeof json?.error === "string"
        ? json.error
        : "The local browser could not be reached.",
    );
  }
  return json as T;
}

export async function fetchLocalBrowserStatus(): Promise<LocalBrowserStatus> {
  const response = await authFetch(
    "/api/mcp/computers/local-browser/status",
    { method: "GET" },
  );
  if (!response.ok) throw new Error("The local browser is not available here.");
  return (await response.json()) as LocalBrowserStatus;
}

export function startLocalBrowserInstall(
  consentToken: string | null,
): Promise<{ install: LocalBrowserStatus["install"] }> {
  return post("install", {}, consentToken);
}

export function ensureLocalBrowser(
  projectId: string,
  consentToken: string | null,
): Promise<LocalBrowserSession> {
  return post("ensure", { projectId }, consentToken);
}

export function mintLocalBrowserFrameNonce(
  projectId: string,
  consentToken: string | null,
): Promise<{ nonce: string; expiresAtMs: number }> {
  return post("token", { projectId }, consentToken);
}

export function actOnLocalBrowserLease(
  args: {
    bootId: string;
    action: "acquire" | "heartbeat" | "resume";
    holder: string;
  },
  consentToken: string | null,
  /** `keepalive` lets a hand-back outlive the page that sent it. */
  options?: { keepalive?: boolean },
): Promise<{ lease: LocalBrowserLease }> {
  return post("lease", args, consentToken, options);
}

export function sendLocalBrowserInput(
  args: { bootId: string; holder: string; events: LocalBrowserInputEvent[] },
  consentToken: string | null,
): Promise<{ ok: true }> {
  return post("input", args, consentToken);
}

export const LOCAL_BROWSER_FRAMES_PATH =
  "/api/web/computers/local-browser/frames";

/** A frame as it arrives: base64 JPEG plus the geometry it measured itself at. */
export interface LocalBrowserFrame {
  data: string;
  deviceWidth: number;
  deviceHeight: number;
  scale: number;
  ts: number;
  seq: number;
}

export interface FrameStreamHandlers {
  onFrame(frame: LocalBrowserFrame): void;
  onClose(code: number, reason: string): void;
}

/**
 * Open the frame socket.
 *
 * The nonce rides `Sec-WebSocket-Protocol` because a browser cannot set
 * headers on a WS handshake and a query string would land in access logs —
 * the same reasoning, and the same shape, as the local terminal's.
 */
export function openLocalBrowserFrameStream(args: {
  bootId: string;
  holder: string;
  nonce: string;
}): { socket: WebSocket; close(): void } {
  // The nonce is a bearer capability and the frames are pictures of a
  // signed-in browser; neither goes over an unencrypted non-loopback hop.
  assertSecureLocalOrigin();
  const base = window.location.origin.replace(/^http/, "ws");
  const url = `${base}${LOCAL_BROWSER_FRAMES_PATH}?bootId=${encodeURIComponent(
    args.bootId,
  )}&holder=${encodeURIComponent(args.holder)}`;
  const socket = new WebSocket(url, [args.nonce]);
  return {
    socket,
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    },
  };
}

/**
 * Where a click on the rendered image lands in the PAGE.
 *
 * Scaling happens here rather than on the server because only the client knows
 * its rendered rectangle and how `object-contain` letterboxes the picture
 * inside it. A click on a letterbox bar is DROPPED rather than mapped to the
 * nearest edge: the page has nothing there, and pretending otherwise puts a
 * click somewhere the person did not aim.
 */
export function toPageCoordinates(
  event: { clientX: number; clientY: number },
  image: { getBoundingClientRect(): DOMRect },
  frame: { deviceWidth: number; deviceHeight: number; scale: number },
  options: {
    /**
     * Clamp to the page instead of dropping, for the events that MUST land.
     *
     * A drag that ends over a letterbox bar is the case: dropping its
     * `mouse_up` leaves the page holding a button down forever, mid-selection.
     * Nothing is guessed about intent — the release is simply attributed to
     * the nearest point the page actually has.
     */
    clampToPage?: boolean;
  } = {},
): { x: number; y: number } | null {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const cssWidth = frame.deviceWidth / (frame.scale || 1);
  const cssHeight = frame.deviceHeight / (frame.scale || 1);
  if (cssWidth <= 0 || cssHeight <= 0) return null;

  // `object-contain`: the picture is centred and scaled to fit, so the bars
  // are the difference between the element and the fitted picture.
  const fit = Math.min(rect.width / cssWidth, rect.height / cssHeight);
  const renderedWidth = cssWidth * fit;
  const renderedHeight = cssHeight * fit;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;

  const x = (event.clientX - rect.left - offsetX) / fit;
  const y = (event.clientY - rect.top - offsetY) / fit;
  if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) {
    if (!options.clampToPage) return null;
    return {
      x: Math.round(Math.min(Math.max(x, 0), cssWidth)),
      y: Math.round(Math.min(Math.max(y, 0), cssHeight)),
    };
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Bound how much pointer traffic is in flight at once.
 *
 * A person dragging generates a `mousemove` per frame, and one POST each meant
 * dozens of concurrent unordered requests: input arriving out of order puts a
 * drag somewhere it never went. One request is in flight at a time, the rest
 * queue, and consecutive moves in the queue collapse — an intermediate
 * position nobody saw is not worth a round trip, but the one they stopped at
 * always is.
 *
 * A queue is also a way to send input under a permission that has since gone.
 * `cancel()` is what the pane calls when the lease is handed back or the
 * project changes: whatever is still queued belonged to the hold that just
 * ended, and delivering it afterwards types into somebody else's page.
 */
export function createInputForwarder(
  send: (events: LocalBrowserInputEvent[]) => Promise<unknown>,
) {
  let queue: LocalBrowserInputEvent[] = [];
  let inFlight = false;
  let cancelled = false;

  const flush = () => {
    if (inFlight || cancelled || queue.length === 0) return;
    // Chunked at the server's own batch limit. A slow POST can leave more than
    // this queued, and the route SLICES what it will accept — so a single
    // oversized request silently drops its tail, which for key and button
    // events means a page left holding a key nobody is pressing.
    const coalesced = coalesceInput(queue);
    const batch = coalesced.splice(0, INPUT_BATCH_LIMIT);
    queue = coalesced;
    inFlight = true;
    void send(batch)
      .catch(() => {
        // A refused batch is not worth a banner; the lease read says why.
      })
      .finally(() => {
        inFlight = false;
        flush();
      });
  };

  return {
    push(events: LocalBrowserInputEvent[]) {
      if (cancelled || events.length === 0) return;
      queue.push(...events);
      flush();
    },
    /** Drop what is queued and refuse more. Not reusable afterwards. */
    cancel() {
      cancelled = true;
      queue = [];
    },
  };
}

/** Drop a move that another move immediately replaces. */
export function coalesceInput(
  events: readonly LocalBrowserInputEvent[],
): LocalBrowserInputEvent[] {
  const out: LocalBrowserInputEvent[] = [];
  for (const event of events) {
    if (
      event.type === "mouse_move" &&
      out.length > 0 &&
      out[out.length - 1]?.type === "mouse_move"
    ) {
      out[out.length - 1] = event;
      continue;
    }
    out.push(event);
  }
  return out;
}

/** CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}
