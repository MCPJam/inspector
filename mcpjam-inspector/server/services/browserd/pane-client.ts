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

import type { BrowserStateSnapshot } from "../../../shared/browser-session-state";
import {
  decodeSessionViewport,
  decodeStateSnapshot,
  paneCommandFromStatus,
} from "../../../shared/browser-pane-wire";
import type {
  BrowserPaneCommand,
  BrowserPaneHolder,
  InteractionAnchor,
} from "../../../shared/browser-pane-command";
import type { SessionViewport } from "../../../shared/browser-viewport";

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
  return decodeStateSnapshot(res.body);
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
  const result = paneCommandFromStatus(res.status, res.body);
  if (result.ok) return result;
  // `no_session` is the inspector routes' vocabulary, not the daemon's: the
  // daemon always has a session (it IS one), so a 409 from it is only ever a
  // changed page.
  return result.reason === "no_session"
    ? { ok: false, reason: "failed" }
    : result;
}

/** Re-exported so callers of this module need only one import. */
export { decodeSessionViewport as decodeViewport };
