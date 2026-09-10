/**
 * Reading the browser shell's answers off the wire.
 *
 * In `shared/` rather than beside either caller because BOTH ends decode the
 * same three payloads. The inspector's routes decode what the daemon sent so
 * they can map its status codes onto their own; the client decodes what the
 * inspector sent so it can fold the result into the shell's state. Two copies
 * would be two opinions about what a missing `activeTabId` means, and the
 * difference would only ever show up as a tab strip that highlights nothing.
 *
 * Every function here is total: it takes `unknown` and returns a value or
 * null, never throws. The input is a parsed JSON body from a network call, and
 * a shell that crashed because a field arrived as a string is a browser that
 * disappears when the server has a bad day.
 */

import type {
  BrowserControlState,
  BrowserStateSnapshot,
  BrowserTabState,
} from "./browser-session-state";
import {
  INITIAL_SESSION_VIEWPORT,
  parseViewportPolicy,
  type SessionViewport,
} from "./browser-viewport";
import type { BrowserPaneHolder } from "./browser-pane-command";

/** Longest strings we will carry from a page into the app's own DOM. */
const MAX_TITLE_CHARS = 256;
const MAX_URL_CHARS = 4096;
const MAX_FAVICON_CHARS = 2048;

export function decodeSessionViewport(raw: unknown): SessionViewport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.width !== "number" ||
    typeof value.height !== "number" ||
    typeof value.revision !== "number"
  ) {
    return null;
  }
  return {
    width: value.width,
    height: value.height,
    revision: value.revision,
  };
}

export function decodeBrowserTab(raw: unknown): BrowserTabState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id) return null;
  const favicon =
    typeof value.faviconUrl === "string" &&
    value.faviconUrl.length <= MAX_FAVICON_CHARS &&
    // Only schemes a renderer will paint. The strip renders this straight into
    // an `img`, and the value was chosen by whatever page the agent is on.
    (value.faviconUrl.startsWith("https://") ||
      value.faviconUrl.startsWith("http://") ||
      value.faviconUrl.startsWith("data:image/"))
      ? value.faviconUrl
      : undefined;
  return {
    id: value.id,
    url: typeof value.url === "string" ? value.url.slice(0, MAX_URL_CHARS) : "",
    title:
      typeof value.title === "string"
        ? value.title.slice(0, MAX_TITLE_CHARS)
        : "",
    ...(favicon ? { faviconUrl: favicon } : {}),
    loading: value.loading === true,
    ...(typeof value.openerId === "string" ? { openerId: value.openerId } : {}),
    ...(Number.isSafeInteger(value.navCounter)
      ? { navCounter: value.navCounter as number }
      : {}),
  };
}

/**
 * Who is driving.
 *
 * Anything unreadable is `agent`, which may look like the wrong default and is
 * the safe one: it means the shell offers no hand-back and forwards no input,
 * so an answer we could not parse costs a person one extra click rather than
 * letting them type into a page somebody else is holding.
 */
export function decodeBrowserControl(raw: unknown): BrowserControlState {
  if (typeof raw !== "object" || raw === null) return { kind: "agent" };
  const value = raw as Record<string, unknown>;
  const kind =
    value.kind === "human" || value.kind === "script" ? value.kind : "agent";
  return {
    kind,
    ...(typeof value.holder === "string" ? { holder: value.holder } : {}),
    ...(value.parked === true ? { parked: true } : {}),
  };
}

export function decodeStateSnapshot(raw: unknown): BrowserStateSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.tabs)) return null;
  const tabs = body.tabs
    .map(decodeBrowserTab)
    .filter((tab): tab is BrowserTabState => tab !== null);
  const activeTabId =
    typeof body.activeTabId === "string" ? body.activeTabId : null;
  return {
    seq: typeof body.seq === "number" ? body.seq : 0,
    tabs,
    // An active id naming a tab that is not in the list reads as "no tab is on
    // screen", which is worse than picking the first: the shell would draw an
    // empty address bar over a page that is plainly there.
    activeTabId:
      activeTabId && tabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : (tabs[0]?.id ?? null),
    canGoBack: body.canGoBack === true,
    canGoForward: body.canGoForward === true,
    control: decodeBrowserControl(body.control),
    viewport: decodeSessionViewport(body.viewport) ?? INITIAL_SESSION_VIEWPORT,
    policy: parseViewportPolicy(body.policy),
  };
}

/**
 * What a pane command did.
 *
 * The reasons are separate cases rather than one message because the pane's
 * response differs for each: `lease_held` names who has it, `page_changed`
 * shows a one-line retry notice, `unsupported` hides the controls, and
 * anything else is an error worth putting on screen.
 */
export type PaneCommandResult =
  | { ok: true; viewport?: SessionViewport }
  | { ok: false; reason: "lease_held"; holder?: BrowserPaneHolder }
  | { ok: false; reason: "page_changed" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "no_session" }
  | { ok: false; reason: "failed"; detail?: string };

export function decodePaneHolder(raw: unknown): BrowserPaneHolder | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  return {
    kind: value.kind === "script" ? "script" : "human",
    ...(typeof value.id === "string" ? { id: value.id } : {}),
  };
}

/**
 * Turn an HTTP status and body into a pane-command result.
 *
 * Shared by both engines' clients, which answer the same codes for the same
 * reasons — the local route and the hosted route were written to agree, and
 * this is what stops them drifting apart later.
 */
export function paneCommandFromStatus(
  status: number,
  body: Record<string, unknown> | null,
): PaneCommandResult {
  if (status >= 200 && status < 300) {
    const viewport = decodeSessionViewport(body?.viewport);
    return { ok: true, ...(viewport ? { viewport } : {}) };
  }
  if (status === 423) {
    const holder = decodePaneHolder(body?.holder);
    return { ok: false, reason: "lease_held", ...(holder ? { holder } : {}) };
  }
  if (status === 409) {
    return body?.error === "page_changed"
      ? { ok: false, reason: "page_changed" }
      : { ok: false, reason: "no_session" };
  }
  if (status === 501) return { ok: false, reason: "unsupported" };
  // 404 is "there is no browser with that bootId" on the local engine — the
  // same thing a hosted 409 means, and the pane's move for both is to stop
  // sending and offer to open one.
  if (status === 404) return { ok: false, reason: "no_session" };
  return {
    ok: false,
    reason: "failed",
    ...(typeof body?.error === "string" ? { detail: body.error } : {}),
  };
}
