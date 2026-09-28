/**
 * What a PERSON can ask the browser to do, and what happens to the agent when
 * they ask it.
 *
 * Separate from `BrowserAction` (the daemon's own verbs) and from
 * `BrowserAgentCommand` (what an outside coding agent may send), and the
 * separation is not bookkeeping. Those two vocabularies answer "what can be
 * done to a page"; this one answers "what can be done to a page BY SOMEBODY
 * WHO IS NOT THE AGENT", which is a smaller set with a completely different
 * gate in front of it. A person may open a tab and cannot invoke a page tool.
 * A person's navigation takes the lease first; an agent's is refused if the
 * lease is held.
 *
 * The route family that carries these is named `pane-command` rather than
 * `command` because the local engine already publishes `/command` for the
 * AGENT, and one path serving two authorities — with the attribution decided
 * by which fields happened to be present — is exactly the ambiguity the
 * ledger's `source` column exists to remove.
 *
 * TAKEOVER IS IMPLICIT, and that is the design. Codex's browser has no "take
 * control" button: you click the page and it is yours. So does this now, and
 * the rules for when it happens live here rather than in three panes, because
 * a pane that took the lease on a hover — or failed to take it on a click —
 * is a bug the other two would not have.
 */

import type { SessionViewport } from "./browser-viewport";

/**
 * The operations a person may drive from the pane.
 *
 * `forward` is new to the whole stack: the daemon had `back` and `reload` and
 * no forward, because the agent contract never offered one — an agent that has
 * just gone back knows where it came from. A person does not, and a browser
 * with a dead forward button is a browser that is visibly broken.
 */
export type BrowserPaneCommand =
  | { op: "navigate"; url: string; tabId?: string }
  | { op: "back"; tabId?: string }
  | { op: "forward"; tabId?: string }
  | { op: "reload"; tabId?: string }
  /** A new tab, at `url` or at the start page when omitted. */
  | { op: "create_tab"; url?: string }
  | { op: "activate_tab"; tabId: string }
  | { op: "close_tab"; tabId: string };

/** Every op, for a runtime allowlist. Exhaustive by construction below. */
export const BROWSER_PANE_OPS = [
  "navigate",
  "back",
  "forward",
  "reload",
  "create_tab",
  "activate_tab",
  "close_tab",
] as const;

export type BrowserPaneOp = (typeof BROWSER_PANE_OPS)[number];

/**
 * Which gestures TAKE the browser, and which are just looking.
 *
 * The line is "does this change what the page or the browser is doing". It is
 * drawn deliberately narrow on the passive side, because the cost of the two
 * mistakes is not symmetric: failing to take control on a click means the
 * click is silently dropped and the person clicks again harder, while taking
 * control on a hover means the agent is stopped mid-task by somebody moving
 * their mouse across the window on the way to the chat box.
 *
 * READING THE ADDRESS IS NOT TAKING. Focusing the field to see the full URL —
 * which is the only way to see it, since the field shows the host at rest — is
 * a thing people do to check where the agent went. Pressing Enter is the
 * commitment, and that is `navigate`.
 *
 * RESIZING IS NOT TAKING either, and that one is load-bearing for the whole
 * responsive-viewport feature: dragging the panel wider while the agent works
 * is the ordinary case, not an intervention.
 */
export type PaneGesture =
  /** Pointer down, wheel, key press into the page. */
  | "input"
  /** Any of the `BrowserPaneCommand` ops. */
  | "command"
  /** Pointer moved over the picture without a button down. */
  | "hover"
  /** The address field took focus, or its text was read. */
  | "read_address"
  /** The panel changed size. */
  | "resize";

const ACQUIRING_GESTURES: ReadonlySet<PaneGesture> = new Set([
  "input",
  "command",
]);

export function gestureAcquires(gesture: PaneGesture): boolean {
  return ACQUIRING_GESTURES.has(gesture);
}

/**
 * What a takeover attempt did, from the pane's point of view.
 *
 * Four outcomes and no boolean, because the pane's next move differs for every
 * one of them: show the picture live, drop the click with a note, refuse and
 * say who has it, or retry.
 */
export type TakeoverOutcome =
  /** The lease is ours; the initiating interaction may be delivered. */
  | { status: "acquired"; deliver: true }
  /**
   * The lease is ours, but the interaction that asked for it is no longer
   * valid — the page navigated, or the tab closed, while we were acquiring.
   *
   * The click is DROPPED, never replayed against the new page. A coordinate
   * decided from one screenshot aimed at a different one is the exact failure
   * `stale_observation` exists to prevent, and it does not stop being that
   * failure because a person rather than a model decided the coordinate.
   */
  | { status: "acquired"; deliver: false; reason: "page_changed" }
  /** We already held it. Nothing to acquire; deliver as normal. */
  | { status: "already_held"; deliver: true }
  /** Somebody else has it. Nothing is delivered, and the pane says who. */
  | { status: "refused"; holder: BrowserPaneHolder };

export interface BrowserPaneHolder {
  kind: "human" | "script";
  /** Present when the server can name them; absent is common and fine. */
  id?: string;
}

/**
 * What the interaction was aimed at, captured BEFORE the acquire is attempted.
 *
 * Both fields are the "still valid?" test. Acquiring a lease is a round trip —
 * on the hosted engine, a round trip to another continent — and a page that
 * finished loading during it is a different page. The daemon's own
 * `stale_observation` guard covers a MODEL's act because the model carries an
 * observation token; a person's click carries nothing, so the pane has to
 * remember what it was looking at.
 */
export interface InteractionAnchor {
  bootId?: string;
  viewportRevision?: number;
  tabId: string;
  /**
   * The observation the click was aimed at, as the pane knows it.
   *
   * The tab's URL and its navigation counter — cheap, and enough: a redirect,
   * a form post, a `pushState` and a reload all move one of the two. A DOM
   * hash would be better and the pane does not have one; the daemon's guard
   * has the DOM and runs after this.
   */
  url: string;
  navCounter: number;
}

/**
 * Is the interaction that asked for the lease still aimed at the same page?
 *
 * A missing `after` — the pane could not re-read the state — counts as
 * CHANGED. The alternative is delivering a click into a page nobody has
 * confirmed, and "we could not check" is not evidence that nothing moved.
 */
export function anchorStillValid(
  before: InteractionAnchor,
  after: InteractionAnchor | null | undefined,
): boolean {
  if (!after) return false;
  return (
    after.tabId === before.tabId &&
    after.url === before.url &&
    after.navCounter === before.navCounter &&
    after.bootId === before.bootId &&
    after.viewportRevision === before.viewportRevision
  );
}

/**
 * The sentence the pane shows when a takeover dropped its own click.
 *
 * A NOTICE, not an error: nothing failed, the page simply moved, and the
 * person's next click will land. Phrased as an instruction because the only
 * useful thing to say is what to do next.
 */
export const TAKEOVER_RETRY_NOTICE =
  "The page changed while taking control — try that again.";

/** The sentence for a takeover somebody else's hold refused. */
export function takeoverRefusedNotice(holder: BrowserPaneHolder): string {
  return holder.kind === "script"
    ? "A script has control of this browser."
    : "Someone else has control of this browser.";
}

/**
 * A pane-command request as it crosses the wire.
 *
 * `holder` is the pane's lease identity and `commandId` is the caller's
 * idempotency key, both mirroring the shapes the existing browser routes
 * already use rather than inventing a third convention.
 */
export interface BrowserPaneCommandRequest {
  command: BrowserPaneCommand;
  holder: string;
  /**
   * Deduplicate a retry. A person double-clicking Reload while the network is
   * slow sends the same command twice, and the second must not queue behind
   * the first.
   */
  commandId?: string;
  /** The anchor the initiating interaction was decided from, when there was one. */
  anchor?: InteractionAnchor;
}

export interface BrowserPaneCommandResponse {
  ok: boolean;
  /** The state after the command, so the pane never has to poll for it. */
  viewport?: SessionViewport;
  error?: string;
}

/**
 * Is this a URL a person may type into the address field?
 *
 * HTTP(S) only, plus the bare hostnames and `host:port` forms people actually
 * type — `localhost:3000` is the single most common thing anybody enters into
 * this particular browser, and refusing it because it has no scheme would make
 * the field useless for the audience it is for.
 *
 * Everything else is refused rather than guessed at. `file:` reads the disk of
 * whatever machine the browser runs on, which on the hosted engine is not the
 * typist's; `javascript:` is script injection into whatever the agent was
 * looking at; `data:` is a page with no origin. None of them is something a
 * person needs from this field, and each is something an attacker would like
 * them to paste into it.
 *
 * NOT A SEARCH BOX. Text that is not a URL is refused, not sent to a search
 * engine — search-engine integration is explicitly out of scope, and quietly
 * shipping a query to a third party because somebody typed a sentence would be
 * the kind of default nobody chose.
 */
export function normalizePaneUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const schemeless = !hasExplicitScheme(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(schemeless ? `https://${trimmed}` : trimmed);
  } catch {
    return null;
  }
  // HTTPS for anything typed without a scheme, EXCEPT loopback — where there
  // is essentially never a certificate, and where a dev server on
  // `localhost:3000` is the single most common thing anybody types here.
  // Guessing http for a public host would be a silent downgrade; somebody who
  // needs one types the scheme, and an explicit scheme is always honoured.
  if (schemeless && isLoopbackHost(parsed.hostname)) {
    try {
      parsed = new URL(`http://${trimmed}`);
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // A URL with no host is `https:///path` — parseable, and not a place.
  if (!parsed.hostname) return null;
  // A bare word ("settings", "readme") became `https://settings` above, which
  // is a legal URL and almost never what was meant. Anything without a dot is
  // refused UNLESS it is a loopback name or carries an explicit port, which is
  // exactly the `localhost:3000` case this field exists for.
  const bare = !parsed.hostname.includes(".");
  if (bare && !isLoopbackHost(parsed.hostname) && !parsed.port) return null;
  return parsed.toString();
}

/**
 * Does this input already name a scheme?
 *
 * `localhost:3000` is why this is not one regex. It matches every
 * scheme-shaped prefix there is — `localhost:` is a perfectly well-formed
 * scheme as far as the grammar is concerned — and `new URL` duly parses it as
 * one, producing a `localhost:` URL with the path `3000`. The second test is
 * what rescues the `host:port` form: a colon followed only by digits, and then
 * the end of the authority, is a port and not a scheme. No real scheme is
 * followed by a bare number.
 */
function hasExplicitScheme(input: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return false;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\d+(?:[/?#]|$)/.test(input);
}

/** Names that resolve to this machine, in the forms `URL` reports them. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * What the address field shows when it is not focused.
 *
 * The HOST, for the same reason the tab strip shows it: a path carries reset
 * tokens, share links and account ids, and this field is a wide element on a
 * screen somebody else can be standing next to. Focusing reveals the whole
 * thing, which is a deliberate act by the person who owns the screen.
 */
export function addressAtRest(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    // The port is part of the identity here in a way it is not on the web at
    // large: `localhost:3000` and `localhost:5173` are two different apps, and
    // a field that showed "localhost" for both would be lying.
    return parsed.host || url;
  } catch {
    return url;
  }
}

/** Snapshot the target before acquiring control; old daemons cannot validate it. */
export function paneInteractionAnchor(
  state: import("./browser-session-state").BrowserSessionState,
  bootId: string | null | undefined,
): InteractionAnchor | undefined {
  const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (!bootId || !tab || tab.navCounter === undefined) return undefined;
  return {
    bootId,
    tabId: tab.id,
    url: tab.url,
    navCounter: tab.navCounter,
    viewportRevision: state.viewport.revision,
  };
}
