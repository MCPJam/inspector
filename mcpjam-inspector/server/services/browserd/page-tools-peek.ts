/**
 * What tools does the page in this project's browser offer, RIGHT NOW, without
 * starting anything?
 *
 * A chat turn needs the answer before it builds its toolset, and the one thing
 * it must not do is create a browser to find out. So this walks the read-only
 * half of the session chain and stops at the first "nothing there":
 *
 *   status(project) → lookup(session row) → daemon status → observe
 *
 * WHAT IT DELIBERATELY NEVER DOES, and why each one would be a real bug:
 *
 *   - `ensureBrowserSession` / `ensureLocalBrowserSession` — these LAUNCH a
 *     Chromium. Asking "does the page have tools?" must not be what opens a
 *     browser window on somebody's desk or bills a cloud desktop for a turn
 *     that was only ever going to answer a question.
 *   - `attachBrowserSession` — resumes a PAUSED box. A paused browser is one
 *     nobody is using; waking it to read a tool list is the same spend under
 *     another name.
 *   - `BrowserTurnState.handle()` — reserves. That is the turn's own lazy
 *     ensure, and calling it here would make every turn with the browser
 *     capability boot a browser whether or not the model ever used one.
 *   - RETRY A `lease_blocked` AS `manual` — the panel routes do that, and they
 *     are right to: a PERSON holding the browser may still look at their own
 *     page. A chat turn is not that person. Re-sending the model's read as
 *     somebody's `manual` command would drive a browser under their hands
 *     using their lease, which is precisely what the lease exists to stop.
 *
 * FAIL-EMPTY, always. Every failure here — no computer, no session, a daemon
 * that will not answer, a deadline — means "this turn advertises no page
 * tools", which is the ordinary state of most turns. The alternative would be
 * a chat turn that fails because a tool-list read it never needed timed out.
 */
import {
  pageToolsFromObservation,
  type BrowserPageTool,
} from "@/shared/browser-page-tools";
import { logger } from "../../utils/logger.js";
import { convexGetDesktopComputerStatus } from "../../utils/computers/convex-environment-client.js";
import { BrowserdClient } from "./browserd-client.js";
import { lookupBrowserSession } from "./browser-sessions-client.js";
import { findLocalBrowserSessionForProject } from "./local/local-browser-session.js";
import { webmcpToolsObserveCommand } from "./page-tools.js";
import { browserdBundleHash } from "./live-session-deps.js";
import type { BrowserdCommandResponse } from "./browserd-codec.js";
import type { WebMcpToolsRevision } from "./protocol.js";

/**
 * How long a turn will wait for the answer.
 *
 * Deliberately short. This runs on the critical path of every browser-capable
 * turn, and the cost of being slow is paid by every one of them while the cost
 * of giving up is paid only by the rare turn whose page had tools AND whose
 * daemon was briefly slow — and that turn recovers on its next step, because
 * the mid-turn refresh reads the same thing again.
 */
export const PAGE_TOOLS_PEEK_DEADLINE_MS = 2_500;

/** Why a turn is advertising no page tools. Shown in the pane, never thrown. */
export type PageToolsPeekReason =
  | "no_browser_session"
  | "no_page"
  | "lease_held"
  | "busy"
  | "unsupported"
  | "unreachable"
  | "timeout";

export interface PageToolsPeek {
  tools: BrowserPageTool[];
  /** Present when a live browser answered; absent when nothing was there. */
  binding?: { bootId: string; tabId: string; navCounter: number };
  revision?: WebMcpToolsRevision;
  url?: string;
  /** Absent when tools were read successfully (even an empty list). */
  reason?: PageToolsPeekReason;
}

const NONE: PageToolsPeek = { tools: [] };

export interface PeekPageToolsArgs {
  engine: "hosted" | "local";
  projectId: string;
  /** Required for the hosted engine; the local one reads an in-process map. */
  bearer?: string;
  /** A per-run disposable box, when the turn brought one. */
  sandboxRowId?: string;
  /** Which tab. Omitted means the daemon's session tab. */
  tabId?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
}

/**
 * Read the page's tools, or answer "none" with a reason.
 *
 * Never throws: the caller is a chat turn assembling a toolset, and there is no
 * failure here worth failing a conversation over.
 */
export async function peekPageTools(
  args: PeekPageToolsArgs,
): Promise<PageToolsPeek> {
  const deadline = AbortSignal.timeout(
    args.deadlineMs ?? PAGE_TOOLS_PEEK_DEADLINE_MS,
  );
  const signal = args.signal
    ? AbortSignal.any([deadline, args.signal])
    : deadline;
  try {
    const work =
      args.engine === "local"
        ? peekLocal(args, signal)
        : peekHosted(args, signal);
    // RACED, not merely signalled. Threading the signal into the transport is
    // what stops a socket being held; it is NOT what bounds this function. The
    // local engine's in-process client has no transport to abort at all, and
    // even on the hosted path a daemon that accepts the connection and then
    // says nothing would hold a chat turn open for as long as it liked. The
    // losing promise is left to settle into a swallowed rejection.
    work.catch(() => {});
    return await Promise.race([work, deadlineAnswer(signal)]);
  } catch (error) {
    if (signal.aborted) return { tools: [], reason: "timeout" };
    // Logged at debug, not warn: on most turns the browser simply is not
    // running, and a warning per turn about the ordinary case is how a log
    // stops being read.
    logger.debug("[page-tools] peek failed; advertising no page tools", {
      projectId: args.projectId,
      engine: args.engine,
      error: error instanceof Error ? error.message : String(error),
    });
    return { tools: [], reason: "unreachable" };
  }
}

/** Resolves to "no page tools" the moment the deadline (or the caller) gives up. */
function deadlineAnswer(signal: AbortSignal): Promise<PageToolsPeek> {
  return new Promise((resolve) => {
    const give = () => resolve({ tools: [], reason: "timeout" });
    if (signal.aborted) give();
    else signal.addEventListener("abort", give, { once: true });
  });
}

async function peekLocal(
  args: PeekPageToolsArgs,
  signal: AbortSignal,
): Promise<PageToolsPeek> {
  let session: ReturnType<typeof findLocalBrowserSessionForProject>;
  try {
    session = findLocalBrowserSessionForProject(args.projectId);
  } catch {
    // An invalid project key is the caller's problem, not a browser fault.
    return { tools: [], reason: "no_browser_session" };
  }
  // READS, NEVER STARTS: nothing here launches a local Chromium.
  if (!session) return { tools: [], reason: "no_browser_session" };
  // No signal: the in-process client hands the command straight to the queue,
  // so there is no transport to abort — the deadline above still bounds the
  // await, and the daemon's own queue bounds the work.
  void signal;
  return readTools(
    (command) => session!.client.sendCommand(command, session!.handle.bootId),
    session.handle.bootId,
    args.tabId,
  );
}

async function peekHosted(
  args: PeekPageToolsArgs,
  signal: AbortSignal,
): Promise<PageToolsPeek> {
  if (!args.bearer) return { tools: [], reason: "no_browser_session" };

  // A per-run box is looked up directly; there is no project computer behind
  // it and asking about one would answer for the wrong browser entirely.
  const lookup = args.sandboxRowId
    ? await lookupBrowserSession({
        sandboxRowId: args.sandboxRowId,
        expectedBundleHash: browserdBundleHash(),
        expectedContextMode: "any",
        signal,
      })
    : await lookupProjectComputerSession(args, signal);
  const session = lookup?.session;
  if (!session) return { tools: [], reason: "no_browser_session" };

  const client = new BrowserdClient({
    baseUrl: session.publicOrigin,
    bearer: session.browserdToken,
  });
  // VERIFIED BEFORE USE, exactly as `tryReuse` does: a row can outlive the
  // daemon it describes, and a command sent to a relaunched daemon under the
  // old bootId is refused as `command_unknown_boot` anyway — this just makes
  // the answer "no browser" instead of a confusing refusal.
  const status = await client.status().catch(() => null);
  if (!status || status.kind !== "ok" || status.bootId !== session.bootId) {
    return { tools: [], reason: "no_browser_session" };
  }
  return readTools(
    (command) => client.sendCommand(command, session.bootId, { signal }),
    session.bootId,
    args.tabId,
  );
}

async function lookupProjectComputerSession(
  args: PeekPageToolsArgs,
  signal: AbortSignal,
) {
  // The cheapest question first: a project with no desktop computer cannot
  // have a browser, and asking the session store would be a round trip to
  // learn the same thing.
  const computer = await convexGetDesktopComputerStatus(
    args.bearer!,
    args.projectId,
  ).catch(() => null);
  // `ready` ONLY. A computer that is starting, paused or stopping has no
  // browser this turn can read, and every other status is one where looking
  // harder means waking something.
  if (!computer || computer.status !== "ready") return null;
  return lookupBrowserSession({
    computerId: computer.computerId,
    expectedBundleHash: browserdBundleHash(),
    // `"any"`: this is about whatever browser the box is running, not about a
    // profile mode. Pinning one reported "no browser" for a box that had one.
    expectedContextMode: "any",
    signal,
  });
}

/** Send the observation and map the daemon's answer. */
async function readTools(
  send: (
    command: ReturnType<typeof webmcpToolsObserveCommand>,
  ) => Promise<BrowserdCommandResponse>,
  bootId: string,
  tabId: string | undefined,
): Promise<PageToolsPeek> {
  const response = await send(
    webmcpToolsObserveCommand({
      // `chat`, because that is what this is. It also means the lease blocks
      // it — which is the correct answer, not a thing to work around.
      source: "chat",
      ...(tabId ? { tabId } : {}),
    }),
  );
  switch (response.status) {
    case "ok":
      break;
    case "lease_blocked":
      // A person has the browser. NOT retried as their `manual` command: the
      // panel may do that because a person looking at their own page is the
      // point of a lease; a chat turn is not that person.
      return { tools: [], reason: "lease_held" };
    case "busy":
    case "at_capacity":
    case "expired":
      return { tools: [], reason: "busy" };
    default:
      return { tools: [], reason: "no_browser_session" };
  }
  const result = response.result;
  if (!result?.ok) {
    // `unknown_tab` is the ORDINARY state between a session starting and the
    // model's first navigation: the driver refuses to conjure an `about:blank`
    // tab to observe, so there is genuinely no page yet.
    return {
      tools: [],
      reason: result?.error?.startsWith("unknown_tab")
        ? "no_page"
        : "unreachable",
    };
  }
  const observation = pageToolsFromObservation(result.output);
  return {
    tools: observation.tools,
    binding: {
      bootId,
      tabId: tabId ?? result.stateToken?.tabId ?? "@session",
      // The generation these tools were read AT. Without it every binding this
      // turn mints would name a document generation nobody checked.
      navCounter: result.stateToken?.navCounter ?? 0,
    },
    ...(result.webmcpTools ? { revision: result.webmcpTools } : {}),
    ...(observation.url ? { url: observation.url } : {}),
    ...(observation.webmcpSupported ? {} : { reason: "unsupported" as const }),
  };
}

/** Nothing to advertise, for a caller that wants the shape without a read. */
export function noPageTools(reason?: PageToolsPeekReason): PageToolsPeek {
  return reason ? { tools: [], reason } : NONE;
}

/**
 * Should this chat turn read the page's tools at all, and if so, what did it
 * find?
 *
 * The gate is here rather than duplicated in the two chat routes because every
 * clause is a rule about correctness, not about a route:
 *
 *   - NO BROWSER CAPABILITY ⇒ no read. A turn that was never going to drive a
 *     browser must not pay a daemon round trip to discover that.
 *   - FLAG OFF ⇒ no read. The off position must be byte-for-byte today.
 *   - A HARNESS TURN ⇒ no read. A harness takes its toolset as a constructor
 *     argument and cannot grow it, so page tools discovered at turn start
 *     would be a set it can never update — worse than not offering them.
 *   - V1 `pageTools` IN THE BODY ⇒ no read. That client is fulfilling page
 *     tools itself through the `page_*` namespace; advertising the SAME page's
 *     tools twice, under two namespaces with two fulfilment paths, is how a
 *     model calls one of each and a person sees two different answers. This
 *     exclusion is transitional and goes away when V1 converges.
 */
export async function peekPageToolsForChatTurn(args: {
  /** The built-in tool ids this turn resolved. */
  builtInToolIds: readonly string[] | undefined;
  /** The catalog id that maps to the browser toolset. */
  browserToolId: string;
  firstClass: boolean;
  isHarnessTurn: boolean;
  hasV1PageTools: boolean;
  engine: "hosted" | "local";
  projectId: string | undefined;
  bearer?: string;
  sandboxRowId?: string;
  signal?: AbortSignal;
}): Promise<PageToolsPeek | undefined> {
  if (!args.firstClass) return undefined;
  if (args.isHarnessTurn) return undefined;
  if (args.hasV1PageTools) return undefined;
  if (!args.projectId) return undefined;
  if (!args.builtInToolIds?.includes(args.browserToolId)) return undefined;
  return peekPageTools({
    engine: args.engine,
    projectId: args.projectId,
    ...(args.bearer ? { bearer: args.bearer } : {}),
    ...(args.sandboxRowId ? { sandboxRowId: args.sandboxRowId } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

/**
 * The peek as the browser toolset takes it, or undefined when there is nothing
 * to build from.
 *
 * The generation travels WITH the tools: a binding is only meaningful against
 * the `navCounter` it was minted at, and the two arriving separately is how a
 * tool list read from one page gets bound to another.
 */
export function pageToolsSnapshotFrom(peek: PageToolsPeek | undefined):
  | {
      tools: readonly BrowserPageTool[];
      bootId: string;
      tabId: string;
      navCounter: number;
      revision?: number;
      hash?: string;
      url?: string;
    }
  | undefined {
  if (!peek?.binding || peek.tools.length === 0) return undefined;
  return {
    tools: peek.tools,
    ...peek.binding,
    ...(peek.revision
      ? { revision: peek.revision.revision, hash: peek.revision.hash }
      : {}),
    ...(peek.url ? { url: peek.url } : {}),
  };
}
