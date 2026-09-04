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
import type { BrowserInputEvent, PaneFrame } from "@/lib/browser-pane/input";

export interface LocalBrowserStatus {
  /**
   * Which Chromium this machine's browser is.
   *
   * The pane does not branch on it — `installed` and `install` already say
   * everything it needs, and the desktop app reports `ready` because Electron
   * IS the browser. It is here so the rail can SAY which one is running, and
   * so a bug report names it without anyone having to guess.
   */
  runtime?: "playwright" | "electron";
  installed: boolean;
  install: {
    status: "idle" | "installing" | "ready" | "failed";
    percent?: number;
    error?: string;
  };
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
    (T & { error?: string }) | null;
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
  const response = await authFetch("/api/mcp/computers/local-browser/status", {
    method: "GET",
  });
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
  args: { bootId: string; holder: string; events: BrowserInputEvent[] },
  consentToken: string | null,
): Promise<{ ok: true }> {
  return post("input", args, consentToken);
}

/**
 * The pane's pointer, keys and frame geometry now live in `lib/browser-pane`,
 * shared with the hosted pane. Re-exported under the names this module's
 * callers already use — the local engine is not a different kind of browser to
 * click on.
 */
export {
  INPUT_BATCH_LIMIT,
  coalesceInput,
  createInputForwarder,
  modifiersOf,
  toPageCoordinates,
} from "@/lib/browser-pane/input";
export type LocalBrowserInputEvent = BrowserInputEvent;
export type LocalBrowserFrame = PaneFrame;

export const LOCAL_BROWSER_FRAMES_PATH =
  "/api/web/computers/local-browser/frames";

export interface FrameStreamHandlers {
  onFrame(frame: PaneFrame): void;
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
