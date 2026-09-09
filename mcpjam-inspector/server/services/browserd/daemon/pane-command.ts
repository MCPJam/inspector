/**
 * A person's command, validated at the daemon and turned into a daemon action.
 *
 * TWO JOBS, and both belong here rather than at the inspector's edge. The
 * daemon listens on its own host — on the hosted engine it is a port in a
 * sandbox — so a check that lives only in the caller is a check an attacker
 * skips. And the mapping from "what a person asked for" to "what the driver
 * does" is a place two vocabularies meet, which is exactly the kind of seam
 * that goes wrong quietly when it is inlined into a request handler.
 *
 * The mapping is deliberately NOT the agent contract's. A person's `close_tab`
 * is the same driver verb an agent's is, but a person's `create_tab` opens a
 * blank tab at the start page while an agent's `navigate {newTab}` demands a
 * URL and an explicit tab id — because the agent is addressing a tab it will
 * come back to, and the person is opening one to type into.
 */

import { randomUUID } from "node:crypto";
import type { BrowserAction } from "../protocol";
import {
  BROWSER_PANE_OPS,
  normalizePaneUrl,
  type BrowserPaneCommand,
  type InteractionAnchor,
} from "../../../../shared/browser-pane-command";

/**
 * Where a new tab starts.
 *
 * `about:blank` rather than a page of ours, and that is a decision rather than
 * a default. A start page served from the inspector would be a document with
 * this app's origin sitting inside the agent's browser — same-origin with
 * nothing here, but a page the agent can navigate, read and be told to act on,
 * and one whose URL a person could be persuaded to trust. The pane draws its
 * own start screen over a blank tab instead, which is a picture rather than a
 * page and cannot be reached from inside the browser at all.
 */
export const PANE_NEW_TAB_URL = "about:blank";

const PANE_OPS = new Set<string>(BROWSER_PANE_OPS);

/** Longest tab id a pane may name. Ids are minted here; this is a sanity cap. */
const MAX_TAB_ID_CHARS = 200;

/**
 * Read a pane command off the wire, or refuse it.
 *
 * REFUSES rather than repairs. Every field here was typed by a person into a
 * field or clicked on a control this app drew, so a malformed one is not a
 * caller to be generous to — it is a caller that is not the pane.
 */
export function parsePaneCommand(raw: unknown): BrowserPaneCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const op = value.op;
  if (typeof op !== "string" || !PANE_OPS.has(op)) return null;
  const tabId =
    typeof value.tabId === "string" && value.tabId.length <= MAX_TAB_ID_CHARS
      ? value.tabId
      : undefined;
  switch (op) {
    case "navigate": {
      if (typeof value.url !== "string") return null;
      // Normalised HERE, so the driver is handed a URL and never a fragment of
      // one — and so `file:` and `javascript:` are refused on the far side of
      // the network too, not only in the field somebody typed into.
      const url = normalizePaneUrl(value.url);
      if (!url) return null;
      return { op: "navigate", url, ...(tabId ? { tabId } : {}) };
    }
    case "back":
    case "forward":
    case "reload":
      return { op, ...(tabId ? { tabId } : {}) };
    case "create_tab": {
      if (value.url === undefined) return { op: "create_tab" };
      if (typeof value.url !== "string") return null;
      const url = normalizePaneUrl(value.url);
      if (!url) return null;
      return { op: "create_tab", url };
    }
    case "activate_tab":
    case "close_tab":
      if (!tabId) return null;
      return { op, tabId };
    default:
      return null;
  }
}

/** The pane's anchor, or undefined when it did not send a usable one. */
export function parseAnchor(raw: unknown): InteractionAnchor | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.tabId !== "string" ||
    typeof value.url !== "string" ||
    typeof value.navCounter !== "number"
  ) {
    return undefined;
  }
  return {
    tabId: value.tabId,
    url: value.url,
    navCounter: value.navCounter,
  };
}

export interface MappedPaneAction {
  action: BrowserAction;
  tabId?: string;
}

/**
 * What the driver should do about it.
 *
 * `create_tab` mints its own id rather than taking one from the caller. The
 * driver's `navigate {newTab}` requires an explicit, unused tabId — it refuses
 * a collision rather than silently replacing a tab's page — and a pane that
 * chose its own ids would either have to track which are free or discover the
 * collision as an error a person cannot act on.
 */
export function paneCommandToAction(
  command: BrowserPaneCommand,
): MappedPaneAction {
  switch (command.op) {
    case "navigate":
      return {
        action: { kind: "navigate", url: command.url, observe: "none" },
        ...(command.tabId ? { tabId: command.tabId } : {}),
      };
    case "back":
      return {
        action: { kind: "back", observe: "none" },
        ...(command.tabId ? { tabId: command.tabId } : {}),
      };
    case "forward":
      return {
        action: { kind: "forward", observe: "none" },
        ...(command.tabId ? { tabId: command.tabId } : {}),
      };
    case "reload":
      return {
        action: { kind: "reload", observe: "none" },
        ...(command.tabId ? { tabId: command.tabId } : {}),
      };
    case "create_tab":
      return {
        action: {
          kind: "navigate",
          url: command.url ?? PANE_NEW_TAB_URL,
          newTab: true,
          observe: "none",
        },
        tabId: `pane-${randomUUID().slice(0, 8)}`,
      };
    case "activate_tab":
      return {
        action: { kind: "act", verb: "activate_tab", observe: "none" },
        tabId: command.tabId,
      };
    case "close_tab":
      return {
        action: { kind: "act", verb: "close_tab", observe: "none" },
        tabId: command.tabId,
      };
    default: {
      const exhaustive: never = command;
      throw new Error(
        `pane command ${JSON.stringify(exhaustive)} has no daemon action`,
      );
    }
  }
}
