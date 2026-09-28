/**
 * The Tools pane's read AND manual invoke of a page's WebMCP tools, for
 * EITHER engine.
 *
 * Both routes that serve the pane — the hosted panel's `/page-tools` and the
 * local `/local-browser/page-tools` — build the same commands and map the
 * daemon's answer through the same tables below. The chat turn's own
 * page-tool peek sends the observation too, which is what makes the pane a
 * truthful preview of what the model was actually given.
 *
 * Pure: no daemon, no HTTP. The routes own auth and session lookup; this owns
 * "what did the daemon say, and what does the pane tell the person".
 */
import { randomUUID } from "node:crypto";
import {
  pageToolsFromObservation,
  type BrowserPageToolInvokeResponse,
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
    responsiveViewport: true,
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

/**
 * A person clicked Run on a page tool they can see.
 *
 * Source is stamped here, never taken from an HTTP body: `inspector` is the
 * same identity as the tool-list read (allowed while the agent is driving),
 * and `manual` is this person's own command once they hold the lease. A
 * route that let the body choose `manual` without a live holder check would
 * let a caller drive a browser somebody is signing into.
 *
 * No `expectedBinding`: this is click-now-run-now, not an approval window
 * that must still name the registration that was listed.
 */
export function webmcpInvokeCommand(args: {
  source: "inspector" | "manual";
  toolKey: string;
  input: unknown;
  tabId?: string;
  frameId?: string;
  /** Required with `source: "manual"` — the lease holder the invoke acts as. */
  holder?: string;
}): BrowserCommand {
  return {
    commandId: randomUUID(),
    responsiveViewport: true,
    source: args.source,
    ...(args.holder ? { holder: args.holder } : {}),
    ...(args.tabId ? { tabId: args.tabId } : {}),
    action: {
      kind: "webmcp_invoke",
      toolKey: args.toolKey,
      ...(args.frameId ? { frameId: args.frameId } : {}),
      input: args.input,
    },
  };
}

/**
 * Send the invoke the Tools pane's read already uses: `inspector` first, so
 * a click works while the agent is driving (lease free). `manual` requires
 * a held lease that matches the holder — sending it first is what made Run
 * say `lease_held` on a browser nobody had taken.
 *
 * If the inspector hop is refused and we have a holder, retry as that
 * holder's `manual` command — the person who took the page can still Run.
 */
export async function sendPageToolInvoke(
  send: (
    command: BrowserCommand,
    bootId?: string,
  ) => Promise<BrowserdCommandResponse>,
  args: {
    toolKey: string;
    input: unknown;
    tabId?: string;
    frameId?: string;
    holder?: string;
    bootId?: string;
  },
): Promise<BrowserdCommandResponse> {
  const fields = {
    toolKey: args.toolKey,
    input: args.input,
    ...(args.tabId ? { tabId: args.tabId } : {}),
    ...(args.frameId ? { frameId: args.frameId } : {}),
  };
  let response = await send(
    webmcpInvokeCommand({ source: "inspector", ...fields }),
    args.bootId,
  );
  if (response.status === "lease_blocked" && args.holder) {
    response = await send(
      webmcpInvokeCommand({
        source: "manual",
        holder: args.holder,
        ...fields,
      }),
      args.bootId,
    );
  }
  return response;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The invoke fields both routes accept. `source` is ignored even if present —
 * the command builder stamps `manual`.
 */
export function pageToolInvokeFromBody(body: unknown):
  | {
      ok: true;
      toolKey: string;
      input: Record<string, unknown>;
      frameId?: string;
      tabId?: string;
    }
  | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: "invalid_body" };
  const toolKey = typeof body.toolKey === "string" ? body.toolKey.trim() : "";
  if (!toolKey) return { ok: false, error: "toolKey is required" };
  if (body.input !== undefined && !isPlainObject(body.input)) {
    return { ok: false, error: "input must be an object" };
  }
  const frameId =
    typeof body.frameId === "string" && body.frameId.length > 0
      ? body.frameId
      : undefined;
  const tabId =
    typeof body.tabId === "string" && body.tabId.length > 0
      ? body.tabId
      : undefined;
  return {
    ok: true,
    toolKey,
    input: isPlainObject(body.input) ? body.input : {},
    ...(frameId ? { frameId } : {}),
    ...(tabId ? { tabId } : {}),
  };
}

/**
 * One daemon reply to a page-tool invoke.
 *
 * A tool that ran and failed is still a 200: the pane shows the page's
 * error, the same way the Inspector does. Transport refusals keep the
 * codes the read already uses.
 */
export function pageToolInvokeFromCommandResponse(
  response: BrowserdCommandResponse,
): { status: 200 | 409 | 423 | 429 | 502; body: BrowserPageToolInvokeResponse } {
  switch (response.status) {
    case "ok":
      if (response.result.ok) {
        return {
          status: 200,
          body: { ok: true, output: response.result.output },
        };
      }
      if (response.result.error?.startsWith("unknown_tab")) {
        return { status: 409, body: { ok: false, error: "no_page" } };
      }
      return {
        status: 200,
        body: {
          ok: false,
          error: response.result.error ?? "invoke_failed",
        },
      };
    case "lease_blocked":
      return { status: 423, body: { ok: false, error: "lease_held" } };
    case "busy":
    case "at_capacity":
    case "expired":
      return { status: 429, body: { ok: false, error: "busy" } };
    case "unknown_boot":
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
