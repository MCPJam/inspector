/**
 * The Tools pane's read of a page's WebMCP tools, for EITHER engine.
 *
 * Both routes that serve the pane — the hosted panel's `GET /page-tools` and
 * the local `POST /local-browser/page-tools` — build the same command and map
 * the daemon's answer through the same table below. The model's
 * `browser_webmcp_tools` tool sends this exact observation too, which is what
 * makes the pane a truthful preview of what the model would be told.
 *
 * Pure: no daemon, no HTTP. The routes own auth and session lookup; this owns
 * "what did the daemon say, and what does the pane tell the person".
 */
import { randomUUID } from "node:crypto";
import {
  pageToolsFromObservation,
  type BrowserPageToolsResponse,
} from "@/shared/browser-page-tools";
import type { BrowserdCommandResponse } from "./browserd-codec.js";
import type { BrowserCommand, BrowserCommandSource } from "./protocol.js";

/** The command the pane sends: the model's own tool-list observation. */
export function webmcpToolsObserveCommand(args: {
  source: BrowserCommandSource;
  tabId?: string;
  /** Required with `source: "manual"` — the lease holder the read acts as. */
  holder?: string;
}): BrowserCommand {
  return {
    commandId: randomUUID(),
    source: args.source,
    ...(args.holder ? { holder: args.holder } : {}),
    ...(args.tabId ? { tabId: args.tabId } : {}),
    action: { kind: "observe", mode: "webmcp_tools" },
  };
}

/**
 * The HTTP status and body for one daemon reply.
 *
 * Both layers are read (transport status AND `result.ok`), exactly as the
 * model's tool layer reads them: a command can be refused before it runs or
 * fail inside the browser, and only the first has a transport status.
 */
export function pageToolsFromCommandResponse(
  response: BrowserdCommandResponse,
): { status: 200 | 409 | 423 | 429 | 502; body: BrowserPageToolsResponse } {
  switch (response.status) {
    case "ok":
      if (response.result.ok) {
        return {
          status: 200,
          body: pageToolsFromObservation(response.result.output),
        };
      }
      // A running browser with nothing open in it. The driver refuses to
      // conjure an `about:blank` tab just to observe one (P2), so this is the
      // ordinary answer between a session starting and the model's first
      // navigation — a state to NAME, not a failure to report.
      if (response.result.error?.startsWith("unknown_tab")) {
        return { status: 409, body: { ok: false, error: "no_page" } };
      }
      return {
        status: 502,
        body: {
          ok: false,
          error: "unreachable",
          ...(response.result.error ? { detail: response.result.error } : {}),
        },
      };
    case "lease_blocked":
      // A person has the browser. The daemon refused to LOOK, which is the
      // privacy rule working — so this is a pause the pane names, not a fault.
      return { status: 423, body: { ok: false, error: "lease_held" } };
    case "busy":
    case "at_capacity":
    case "expired":
      return { status: 429, body: { ok: false, error: "busy" } };
    case "unknown_boot":
      // The daemon the row describes is gone (relaunched, or never came back
      // from a wake). To the pane that is the same as no browser: the next
      // chat turn re-ensures one.
      return { status: 409, body: { ok: false, error: "no_browser_session" } };
    default:
      return {
        status: 502,
        body: {
          ok: false,
          error: "unreachable",
          detail: `unexpected daemon status: ${response.status}`,
        },
      };
  }
}
