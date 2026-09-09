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
import { BROWSER_SESSION_ID_HEADER } from "@/shared/browser-session-header";

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
import type { BrowserStateSnapshot } from "../../../../shared/browser-session-state";
import type {
  BrowserPaneCommand,
  InteractionAnchor,
} from "../../../../shared/browser-pane-command";
import type { SessionViewport } from "../../../../shared/browser-viewport";
import {
  decodeSessionViewport,
  decodeStateSnapshot,
  paneCommandFromStatus,
  type PaneCommandResult,
} from "../../../../shared/browser-pane-wire";

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
  /**
   * How this pane will SEE the browser.
   *
   * `native` means a real `WebContentsView` is parented into the app's own
   * window at this pane's bounds — the page itself, not a picture of it — so
   * the pane opens NO frame socket and renders no canvas. `frames` is the JPEG
   * screencast, and the only thing a Playwright browser in another process can
   * offer.
   *
   * Optional because an inspector from before this wave does not send it, and
   * an absent field must mean the path that has always worked.
   */
  surface?: "native" | "frames";
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
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new LocalBrowserRequestError(
      typeof json?.error === "string"
        ? json.error
        : "The local browser could not be reached.",
      response.status,
      json as Record<string, unknown> | null,
    );
  }
  return json as T;
}

/**
 * A refusal from the local browser routes, with the status still on it.
 *
 * WHICH refusal matters to a caller. A 404 from a route keyed by `bootId` says
 * that browser is GONE — a fact the pane has to act on by offering to open a
 * new one — while a 500 or a dropped connection says try again in a moment.
 * Answering both with a bare `Error` made every caller treat the first as the
 * second, and wait forever on a browser that had already been reaped.
 */
export class LocalBrowserRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The parsed response body, when there was one.
     *
     * Carried because a refusal's body is not decoration: a 423 names the
     * holder, and an error that kept only `message` left the shared mapper
     * with nothing to decode — so a browser held by a SCRIPT was announced to
     * the person as one held by another person. The hosted client passes its
     * whole body and got this right, which made the two engines disagree about
     * the same refusal.
     */
    readonly body?: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "LocalBrowserRequestError";
  }
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
  sessionId?: string,
): Promise<LocalBrowserSession> {
  return post(
    "ensure",
    { projectId, ...(sessionId ? { sessionId } : {}) },
    consentToken,
  );
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

/**
 * Tell the server somebody is still looking at this browser, and hear back
 * who holds it.
 *
 * The frame socket's heartbeat did this for every other engine; the native
 * Electron surface has no socket, so a watcher who is not holding the lease
 * would otherwise be reaped mid-glance. Failure is ignored by every caller —
 * a missed heartbeat costs one interval, and an error here would be a red
 * message over a browser that is working perfectly.
 */
export function noteLocalBrowserWatch(
  args: { bootId: string },
  consentToken: string | null,
): Promise<{ watching: boolean; lease?: LocalBrowserLease }> {
  return post("watch", args, consentToken);
}

/**
 * The sessions an agent has opened for this project, newest first.
 *
 * The rail knows a project; an agent's session was opened elsewhere. Without
 * this the Activity list has nothing to read, and asking a person to paste a
 * session id into a side panel is not a side panel anybody would use.
 */
export function listLocalBrowserSessions(
  projectId: string,
  consentToken: string | null,
): Promise<{ sessions: LocalAgentSession[] }> {
  return post("sessions", { projectId }, consentToken);
}

/**
 * This session's command history, read forward from a cursor.
 *
 * INCREMENTAL by design: the pane polls with the last `seq` it saw, so a long
 * session costs one small response per tick rather than re-sending its whole
 * history. The server mirrors the daemon's bounded ring on every read, which is
 * also how a command the MODEL issued — one that never went through the agent
 * door — reaches this list.
 */
export function readLocalBrowserTrace(
  args: {
    projectId: string;
    sessionId: string;
    afterSeq?: number;
    limit?: number;
  },
  consentToken: string | null,
): Promise<LocalBrowserTracePage> {
  return post("trace", args, consentToken);
}

export interface LocalAgentSession {
  sessionId: string;
  projectId: string;
  profile: "persistent" | "ephemeral";
  createdAt: number;
  closedAt?: number;
  participants: Array<{ actorId: string; kind: string; joinedAt: number }>;
}

/** One row of the session trace, as the pane needs to read it. */
export interface LocalBrowserTraceRow {
  kind: "command";
  seq: number;
  commandId: string;
  ts: number;
  durationMs: number;
  source: string;
  actor: { kind: string; id: string; label?: string };
  command: {
    kind: string;
    verb?: string;
    mode?: string;
    url?: string;
    value?: string;
    redactedValue?: { redacted: true; chars: number };
    target?: { selector?: string; a11yRef?: string; coordinates?: number[] };
  };
  outcome: "executed" | "refused" | "unknown";
  ok?: boolean;
  errorCode?: string;
  url?: string;
  title?: string;
  artifacts?: {
    screenshot?: {
      id: string;
      bytes: number;
      mediaType: string;
      evicted?: boolean;
    };
  };
}

/** A stretch of history the ledger knows it does not have. */
export interface LocalBrowserTraceGap {
  kind: "gap";
  seq: number;
  ts: number;
  fromSeq: number;
  toSeq: number;
  reason: "ring_overflow" | "daemon_restart" | "sink_unavailable";
}

export type LocalBrowserTraceEntry =
  | LocalBrowserTraceRow
  | LocalBrowserTraceGap;

export interface LocalBrowserTracePage {
  entries: LocalBrowserTraceEntry[];
  headSeq: number;
  /** Set when the newest rows could not be written. Never silent. */
  historyWarning?: string;
}

export function sendLocalBrowserInput(
  args: {
    bootId: string;
    holder: string;
    events: BrowserInputEvent[];
    anchor?: import("../../../../shared/browser-pane-command").InteractionAnchor;
  },
  consentToken: string | null,
): Promise<{ ok: true }> {
  return post("input", args, consentToken);
}

/** Export one persistent local browser profile after closing its session. */
export async function fetchLocalBrowserProfileArchive(args: {
  bootId: string;
  projectId?: string;
  sessionId?: string;
  consentToken: string | null;
}): Promise<{ archive: Blob; savedFrom?: string }> {
  assertSecureLocalOrigin();
  const response = await authFetch(
    "/api/mcp/computers/local-browser/profile/export",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(args.consentToken
          ? { [LOCAL_CONSENT_HEADER]: args.consentToken }
          : {}),
      },
      body: JSON.stringify({
        bootId: args.bootId,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      }),
    },
  );
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    throw new LocalBrowserRequestError(
      typeof json?.error === "string"
        ? json.error
        : "The local browser profile could not be exported.",
      response.status,
    );
  }
  const savedFrom = response.headers.get(BROWSER_SESSION_ID_HEADER) ?? undefined;
  return {
    archive: await response.blob(),
    ...(savedFrom ? { savedFrom } : {}),
  };
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
  /** `"binary"` asks for the daemon's frame records; omitted keeps JSON. */
  wire?: "binary" | "json";
}): { socket: WebSocket; close(): void } {
  // The nonce is a bearer capability and the frames are pictures of a
  // signed-in browser; neither goes over an unencrypted non-loopback hop.
  assertSecureLocalOrigin();
  const base = window.location.origin.replace(/^http/, "ws");
  const url = `${base}${LOCAL_BROWSER_FRAMES_PATH}?bootId=${encodeURIComponent(
    args.bootId,
  )}&holder=${encodeURIComponent(args.holder)}${
    args.wire === "binary" ? "&wire=binary" : ""
  }`;
  const socket = new WebSocket(url, [args.nonce]);
  // See the hosted opener: `blob` would make binary messages arrive
  // asynchronously and out of order against the control messages beside them.
  socket.binaryType = "arraybuffer";
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
 * The browser shell's three calls, on the local engine.
 *
 * All POSTs, like every other local-browser route: the project id and the
 * bootId travel in the body beside the consent capability, and `post` above is
 * what attaches that header.
 *
 * None of them THROWS for a refusal. Every caller is a shell drawing chrome,
 * and the useful answer to "somebody else has the browser" is a banner rather
 * than an exception — so a refusal comes back as a value and only a genuine
 * transport failure is absent.
 */
export async function fetchLocalBrowserState(args: {
  bootId: string;
  holder: string;
  consentToken: string | null;
}): Promise<BrowserStateSnapshot | null> {
  const { consentToken, ...body } = args;
  const answer = await post<{ state?: unknown }>(
    "state",
    body,
    consentToken,
  ).catch(() => null);
  return answer ? decodeStateSnapshot(answer.state) : null;
}

export async function sendLocalPaneCommand(args: {
  bootId: string;
  holder: string;
  command: BrowserPaneCommand;
  commandId?: string;
  anchor?: InteractionAnchor;
  consentToken: string | null;
}): Promise<PaneCommandResult> {
  const { consentToken, ...body } = args;
  try {
    const answer = await post<Record<string, unknown>>(
      "pane-command",
      body,
      consentToken,
    );
    return paneCommandFromStatus(200, answer);
  } catch (error) {
    // `post` throws with the status still attached, which is exactly what the
    // shared mapper reads. Anything else is a transport failure with no status
    // to interpret.
    return error instanceof LocalBrowserRequestError
      ? paneCommandFromStatus(
          error.status,
          error.body ?? { error: error.message },
        )
      : { ok: false, reason: "failed" };
  }
}

export async function reportLocalPaneViewport(args: {
  bootId: string;
  width: number;
  policy?: "fixed" | "followPane";
  height: number;
  consentToken: string | null;
}): Promise<SessionViewport | null> {
  const { consentToken, ...body } = args;
  const answer = await post<{ viewport?: unknown }>(
    "viewport",
    body,
    consentToken,
  ).catch(() => null);
  return answer ? decodeSessionViewport(answer.viewport) : null;
}
