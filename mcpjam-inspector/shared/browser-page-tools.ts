/**
 * The WebMCP tools of the page an agent browser currently has open, as the
 * Playground's Tools pane reads them.
 *
 * One shape for BOTH engines. The hosted panel route and the local route each
 * send the daemon the same `observe {mode:"webmcp_tools"}` the turn-start peek
 * sends, and hand the answer back through this module — so the pane, the model
 * and the two engines can never disagree about what a page offers.
 *
 * Kept apart from `webmcp-inspector-protocol.ts` on purpose: that is the V1
 * WebMCP Inspector's own session protocol (origin-keyed `toolKey`s, SSE
 * registry deltas). This is a read of the browser the MODEL drives, whose
 * tools become first-class `webmcp_*` model tools — see
 * `built-in-tools/page-tools.ts` for how these rows are minted into them.
 */

/** One page tool, as the daemon's WebMCP bridge reports it. */
export interface BrowserPageTool {
  name: string;
  /** Always a string; empty when the page gave none. */
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    consequential?: boolean;
    autosubmit?: boolean;
  };
  /** Scheme + host of the frame that registered it. */
  origin?: string;
  isMainFrame?: boolean;
  registrationKind?: "declarative" | "imperative" | "unknown";
  /**
   * The CDP frame that registered it.
   *
   * Carried through because it is HALF THE IDENTITY once a page tool becomes a
   * model tool: two same-origin duplicate iframes declare the same names with
   * the same origin, and nothing else tells them apart. Dropping it here was
   * fine while the pane only listed names; it is not fine now that the same
   * rows are minted into tools the model calls.
   */
  frameId?: string;
  /**
   * WHICH REGISTRATION, minted by the daemon. The other half: a page that
   * re-registers a tool under an unchanged name in an unchanged frame has a
   * different handler behind it.
   */
  registrationSeq?: number;
}

export interface BrowserPageToolsOk {
  ok: true;
  /** Where the observed tab is. */
  url: string;
  /** False when the page (or this Chromium) has no WebMCP at all. */
  webmcpSupported: boolean;
  tools: BrowserPageTool[];
}

/**
 * Why a read produced no tool list. Each is a state the pane says something
 * different about, which is why they are codes rather than one message.
 *
 *   - `no_browser_session`: nothing is running on this computer yet.
 *   - `no_page`: the browser is running but nothing has opened a page in it.
 *     Its own code rather than an error, because it is the ORDINARY state
 *     between a session starting and the model's first `browser_navigate`:
 *     the daemon deliberately refuses to conjure an `about:blank` tab to
 *     observe, so "no page yet" is the correct and expected answer, and
 *     reporting it as a failure would put a red message over a browser that
 *     is working.
 *   - `lease_held`: a person has the browser; the daemon refuses to observe
 *     under their hands (privacy), so the list is paused, not gone.
 *   - `busy`: the daemon would not admit the command right now.
 *   - `unreachable`: the daemon did not answer, or answered with an error.
 */
export type BrowserPageToolsErrorCode =
  | "no_browser_session"
  | "no_page"
  | "lease_held"
  | "busy"
  | "unreachable";

export interface BrowserPageToolsError {
  ok: false;
  error: BrowserPageToolsErrorCode;
  detail?: string;
}

export type BrowserPageToolsResponse =
  | BrowserPageToolsOk
  | BrowserPageToolsError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize ONE tool out of a daemon observation. Anything without a string
 * name is dropped: a nameless tool cannot be invoked, so listing it would
 * offer something nothing can call.
 */
function pageToolFrom(value: unknown): BrowserPageTool | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !value.name.trim()
  ) {
    return null;
  }
  const tool: BrowserPageTool = {
    name: value.name,
    description: typeof value.description === "string" ? value.description : "",
  };
  if (isRecord(value.inputSchema)) tool.inputSchema = value.inputSchema;
  if (isRecord(value.annotations)) {
    tool.annotations = value.annotations as BrowserPageTool["annotations"];
  }
  if (typeof value.origin === "string") tool.origin = value.origin;
  if (typeof value.frameId === "string") tool.frameId = value.frameId;
  if (typeof value.registrationSeq === "number") {
    tool.registrationSeq = value.registrationSeq;
  }
  if (typeof value.isMainFrame === "boolean") {
    tool.isMainFrame = value.isMainFrame;
  }
  if (
    value.registrationKind === "declarative" ||
    value.registrationKind === "imperative" ||
    value.registrationKind === "unknown"
  ) {
    tool.registrationKind = value.registrationKind;
  }
  return tool;
}

/**
 * Turn the output of `observe {mode:"webmcp_tools"}` into the pane's answer.
 *
 * The daemon returns `{ url, webmcpSupported, tools }` (plus a screenshot and
 * the state token, which are the model's business and are ignored here). A
 * page that offers nothing is a NORMAL answer — `ok: true` with an empty
 * list — because "this page has no tools" is exactly what most pages say, and
 * the pane must be able to say it too rather than show an error.
 */
export function pageToolsFromObservation(output: unknown): BrowserPageToolsOk {
  const record = isRecord(output) ? output : {};
  const tools = Array.isArray(record.tools)
    ? record.tools
        .map(pageToolFrom)
        .filter((tool): tool is BrowserPageTool => tool !== null)
    : [];
  return {
    ok: true,
    url: typeof record.url === "string" ? record.url : "",
    webmcpSupported:
      typeof record.webmcpSupported === "boolean"
        ? record.webmcpSupported
        : tools.length > 0,
    tools,
  };
}
