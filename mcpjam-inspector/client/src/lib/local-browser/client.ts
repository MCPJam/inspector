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
): Promise<T> {
  const response = await authFetch(`/api/mcp/computers/local-browser/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(consentToken ? { [LOCAL_CONSENT_HEADER]: consentToken } : {}),
    },
    body: JSON.stringify(body),
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
): Promise<{ lease: LocalBrowserLease }> {
  return post("lease", args, consentToken);
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
  if (x < 0 || y < 0 || x > cssWidth || y > cssHeight) return null;
  return { x: Math.round(x), y: Math.round(y) };
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
