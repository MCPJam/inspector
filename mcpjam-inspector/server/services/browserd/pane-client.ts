/**
 * The three calls the browser SHELL makes, on either engine.
 *
 * Split out of `SessionClient` rather than added to it because the audience is
 * different in a way that matters for what may be optional. `SessionClient`'s
 * existing methods are what a MODEL's turn needs, and every engine has to
 * answer them; these are what a PERSON'S PANE needs, and an engine that has
 * none of them is still a perfectly good engine for an eval. So they are one
 * optional group a caller can test for in one place, instead of three
 * independent optional methods that can each be present without the others —
 * which would let a shell draw a tab strip it cannot then navigate.
 *
 * The decoding lives here too, for the reason the daemon's own validators do:
 * this reads a JSON body off a socket, and the two implementations (in-process
 * and over HTTP) would otherwise each decide separately what a malformed one
 * means.
 */

import type {
  BrowserSessionState,
  BrowserStateSnapshot,
  BrowserTabState,
} from "../../../shared/browser-session-state";
import type {
  BrowserPaneCommand,
  BrowserPaneHolder,
  InteractionAnchor,
} from "../../../shared/browser-pane-command";
import {
  INITIAL_SESSION_VIEWPORT,
  parseViewportPolicy,
  type SessionViewport,
} from "../../../shared/browser-viewport";

export type PaneCommandOutcome =
  | { ok: true; viewport?: SessionViewport }
  /** Somebody else is driving. Nothing was delivered. */
  | { ok: false; reason: "lease_held"; holder?: BrowserPaneHolder }
  /**
   * The page moved while the lease was being acquired.
   *
   * Its OWN reason rather than a generic failure, because the pane's response
   * is specific and mild: a short notice saying to try again, not an error.
   */
  | { ok: false; reason: "page_changed" }
  | { ok: false; reason: "unsupported" }
  | { ok: false; reason: "failed"; detail?: string };

/** What a pane needs from a browser, on whichever engine it happens to be. */
export interface BrowserPaneClient {
  /** The whole browser, as the shell draws it. Null when the engine cannot say. */
  paneState(args: { holder?: string }): Promise<BrowserStateSnapshot | null>;
  paneCommand(args: {
    holder: string;
    command: BrowserPaneCommand;
    commandId?: string;
    anchor?: InteractionAnchor;
  }): Promise<PaneCommandOutcome>;
  /** Report a panel measurement; resolve with the size the session settled at. */
  paneViewport(args: {
    width: number;
    height: number;
  }): Promise<SessionViewport | null>;
}

/** Does this client speak the shell's language? */
export function supportsPane(
  client: Partial<BrowserPaneClient> | null | undefined,
): client is BrowserPaneClient {
  return (
    !!client &&
    typeof client.paneState === "function" &&
    typeof client.paneCommand === "function" &&
    typeof client.paneViewport === "function"
  );
}

interface RawResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Read a state snapshot, or null.
 *
 * NULL for every failure, including a 423, and the reason is what the caller
 * does with it: a pane that has lost the browser to somebody else keeps the
 * state it last saw and shows the ownership banner, rather than blanking its
 * tab strip. The refusal is already visible through the lease, so a second,
 * destructive signal here would only make the shell flicker between "here are
 * your tabs" and "there is no browser" every time the heartbeat ran.
 */
export function decodePaneState(res: RawResponse): BrowserStateSnapshot | null {
  if (res.status !== 200) return null;
  const body = res.body;
  if (!Array.isArray(body.tabs)) return null;
  const tabs = body.tabs
    .map(decodeTab)
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
    control: decodeControl(body.control),
    viewport: decodeViewport(body.viewport) ?? INITIAL_SESSION_VIEWPORT,
    policy: parseViewportPolicy(body.policy),
  };
}

function decodeTab(raw: unknown): BrowserTabState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    url: typeof value.url === "string" ? value.url : "",
    title: typeof value.title === "string" ? value.title : "",
    ...(typeof value.faviconUrl === "string" && value.faviconUrl
      ? { faviconUrl: value.faviconUrl }
      : {}),
    loading: value.loading === true,
  };
}

function decodeControl(raw: unknown): BrowserSessionState["control"] {
  if (typeof raw !== "object" || raw === null) return { kind: "agent" };
  const value = raw as Record<string, unknown>;
  // Anything we cannot read is `agent`, which is the SAFE default here in a
  // way that may look backwards: it means the shell offers no "hand back" and
  // no input, so an unreadable answer costs a person a click rather than
  // letting them type into a page somebody else is holding.
  const kind =
    value.kind === "human" || value.kind === "script" ? value.kind : "agent";
  return {
    kind,
    ...(typeof value.holder === "string" ? { holder: value.holder } : {}),
    ...(value.parked === true ? { parked: true } : {}),
  };
}

export function decodeViewport(raw: unknown): SessionViewport | null {
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

/**
 * Read a pane command's answer.
 *
 * The status codes are load-bearing and each one leads somewhere different in
 * the pane, which is why this does not collapse to a boolean: 423 shows who
 * has the browser, 409 shows a retry notice, 501 hides the controls entirely,
 * and anything else is an error worth naming.
 */
export function decodePaneCommand(res: RawResponse): PaneCommandOutcome {
  const viewport = decodeViewport(res.body.viewport);
  if (res.status === 200 && res.body.ok !== false) {
    return { ok: true, ...(viewport ? { viewport } : {}) };
  }
  if (res.status === 423) {
    const holder = res.body.holder;
    return {
      ok: false,
      reason: "lease_held",
      ...(typeof holder === "object" && holder !== null
        ? {
            holder: {
              kind:
                (holder as Record<string, unknown>).kind === "script"
                  ? "script"
                  : "human",
              ...(typeof (holder as Record<string, unknown>).id === "string"
                ? { id: (holder as Record<string, unknown>).id as string }
                : {}),
            },
          }
        : {}),
    };
  }
  if (res.status === 409 && res.body.error === "page_changed") {
    return { ok: false, reason: "page_changed" };
  }
  if (res.status === 501) return { ok: false, reason: "unsupported" };
  return {
    ok: false,
    reason: "failed",
    ...(typeof res.body.error === "string" ? { detail: res.body.error } : {}),
  };
}
