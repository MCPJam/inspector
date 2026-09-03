/**
 * The six `browser_*` built-in tools — a real Chromium on the member's cloud
 * computer, driven through the sandbox-local browserd daemon.
 *
 * SERVER-EXECUTED, like `bash` and unlike the `page_*`/`ui_*` namespaces: the
 * model calls a tool, this server sends a command to the daemon and returns
 * the result. Nothing here is client-fulfilled, so no new namespace enters
 * `isClientFulfilledToolName`; the approval classification rides the existing
 * name-keyed `uiToolApprovals` slot purely as policy.
 *
 * TWO THINGS ARE STRUCTURAL, not conventions to remember:
 *
 *   1. FAIL-CLOSED ADVERTISEMENT. `buildBrowserTools` returns nothing unless
 *      the caller ATTESTS how approval reaches the user. Approval on the
 *      hosted engines is classified by NAME from `uiToolApprovals`, and five
 *      `prepareChatV2` call sites (Slack agent, chat-session-turn, the
 *      session-simulation runner, and evals-runner twice) plus the
 *      `runAssistantTurn` eval path thread NOTHING — a browser tool reaching
 *      them would classify as FREE and drive a real browser with no gate. So
 *      the attestation is a parameter, not a lint rule: a surface that has not
 *      thought about approval gets no browser tools, and no edit to those five
 *      call sites is required for them to be safe.
 *
 *   2. A SCREENSHOT REACHES THE MODEL AS AN IMAGE, via `toModelOutput`. The
 *      implementation result carries the capture as base64 in an ordinary
 *      field; left there it is serialized into the tool result as TEXT, which
 *      no provider can see. Every one of these tools targets by coordinates
 *      read off that image, so without the mapping the whole coordinate design
 *      is a blind guess — and the turn pays tens of thousands of tokens for a
 *      string the model cannot read. `browser-session-context.ts` states the
 *      same requirement, and `computer-use-tool.ts` is the sibling that
 *      already meets it.
 *
 *   3. BOTH LAYERS ARE CHECKED on every daemon reply. A command can be
 *      REJECTED (busy, expired, stale) with a non-"ok" transport status, OR
 *      admitted and then fail in the browser (`result.ok === false`). A caller
 *      that branches only on the transport status reads a failed act as
 *      success — which is exactly how `unimplemented_in_w1` used to surface as
 *      HTTP 200. `unwrapCommand` is the single place both are read.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  BROWSER_TOOL_NAMES,
  classifyBrowserToolApprovals,
  type BrowserUnattendedPolicy,
  type UiToolApprovalClassification,
} from "@/shared/client-fulfilled-tools";
import { logger } from "../logger.js";
import { type ExecutionScope } from "../execution-scope.js";
import {
  BROWSERD_OBSERVATION_VIEWPORT,
  isPointInViewport,
  type BrowserAction,
  type BrowserActTarget,
  type BrowserCommand,
  type ObservationStateToken,
} from "../../services/browserd/protocol.js";
import type { BrowserSessionHandle } from "../../services/browserd/browser-session.js";
import type { BrowserContextMode } from "../../services/browserd/browser-sessions-client.js";
import { ensureLiveBrowserSession } from "../../services/browserd/live-session-deps.js";
import { ensureLocalBrowserSession } from "../../services/browserd/local/local-browser-session.js";

export const BROWSER_BUILT_IN_TOOL_ID = "browser";

/**
 * The coordinate space the model is told about, stated in the tool schema and
 * re-checked before a command leaves this process. Read from the protocol so
 * the schema, the daemon's bounds check, and the launched viewport cannot
 * disagree about what "x: 900" means.
 */
const VIEWPORT_W = BROWSERD_OBSERVATION_VIEWPORT.width;
const VIEWPORT_H = BROWSERD_OBSERVATION_VIEWPORT.height;

/**
 * How approval reaches the user for this turn — the thing a surface must
 * attest before it gets interactive browser tools.
 *
 * `attested`: the caller threads the returned classification into the
 * engine's `uiToolApprovals`, so a gated call actually pauses and asks.
 *
 * `unattended`: nobody is watching (eval, swarm, journey), so there is no
 * approval at all — and therefore a DECLARED policy is mandatory. The policy
 * is the substitute for a human: it says up front what this run may do.
 */
export type BrowserApprovalDelivery =
  | { kind: "attested" }
  | { kind: "unattended"; policy: BrowserUnattendedPolicy };

export interface BrowserToolsOptions {
  /** Bearer authorization forwarded to the control plane. */
  authHeader: string;
  /** Project whose computer this turn drives. */
  projectId: string;
  executionScope?: ExecutionScope;
  /**
   * What THIS unattended run is, for keying its throwaway browser.
   *
   * Required for an unattended turn and ignored otherwise. Neither the project
   * nor the swarm identifies a run: a swarm fans out many, and an eval suite
   * runs many iterations against one project — so keying on either hands two
   * concurrent runs the same Chromium, the same cookie jar and each other's
   * logged-in state. There is nothing at this layer that can invent it, so a
   * caller that cannot name the run is refused rather than defaulted.
   */
  runKey?: string;
  /**
   * WHERE the browser runs. Resolved by the registry exactly as bash's engine
   * is, and consumed here as the choice of ensure function — the one seam
   * between the three engines. Everything else in this file is engine-blind.
   */
  engine?: BrowserEngine;
  /** ABSENT ⇒ nothing is built. See the fail-closed note above. */
  approvalDelivery?: BrowserApprovalDelivery;
  /**
   * Ephemeral for unattended runs, persistent for interactive ones. Threaded
   * from `approvalDelivery` rather than configured, because the two must never
   * disagree: a run with nobody watching that inherits a signed-in profile is
   * a run whose verdict was decided by the previous one.
   */
  ensureSession?: (args: {
    bearer: string;
    projectId: string;
    contextMode: BrowserContextMode;
    ownerKey?: string;
    signal?: AbortSignal;
  }) => Promise<BrowserSessionHandle>;
  /** Surfaced to the run when a tool is deliberately not advertised. */
  onToolSuppressed?: (info: { id: string; reason: string }) => void;
}

/** Which engine drives this turn's browser. */
export type BrowserEngine = "hosted" | "local";

export interface BrowserToolsResult {
  tools: ToolSet;
  /**
   * The approval classification for the names actually built. The caller
   * MERGES this into the engine's single `uiToolApprovals` slot — see
   * `mergeUiToolApprovalClassifications`.
   */
  approvals: UiToolApprovalClassification;
}

/** What a daemon reply means once both layers have been read. */
type CommandOutcome =
  | { ok: true; output: unknown; stateToken?: ObservationStateToken; settled?: boolean }
  | { ok: false; error: string; stateToken?: ObservationStateToken; output?: unknown };

/** The daemon client surface these tools use (narrowed for tests). */
interface CommandSender {
  sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
  ): Promise<{
    status: string;
    result?: {
      ok: boolean;
      output?: unknown;
      error?: string;
      stateToken?: ObservationStateToken;
      settled?: boolean;
      staleObservation?: boolean;
    };
    bootId?: string;
  }>;
}

/**
 * Read BOTH failure layers of a daemon reply. The transport status says
 * whether the command was ADMITTED; `result.ok` says whether the browser
 * actually did it. Only when both are good is this a success.
 */
function unwrapCommand(response: {
  status: string;
  result?: {
    ok: boolean;
    output?: unknown;
    error?: string;
    stateToken?: ObservationStateToken;
    settled?: boolean;
    staleObservation?: boolean;
  };
}): CommandOutcome {
  if (response.status === "stale_observation") {
    // L3: the page moved under the model between observing and acting. The
    // act did NOT run, and the fresh observation rides along so the model can
    // re-decide rather than retry blindly.
    return {
      ok: false,
      error:
        "stale_observation: the page changed after the observation this action was based on — " +
        "the action was NOT performed; re-read the page and decide again",
      stateToken: response.result?.stateToken,
      output: response.result?.output,
    };
  }
  if (response.status === "lease_blocked") {
    // A person is using this browser right now. Nothing ran and nothing was
    // observed — the daemon refused before capturing a frame. Say so plainly:
    // "wait" is the correct behavior, and a model told only "blocked" tends to
    // retry in a loop.
    return {
      ok: false,
      error:
        "browser_in_use: a person has taken control of this browser " +
        "(for example to sign in or solve a challenge). Nothing was run and " +
        "nothing was observed. Wait for them to hand it back, then re-observe " +
        "before acting — the page will have moved.",
    };
  }
  if (response.status !== "ok") {
    return { ok: false, error: transportError(response.status) };
  }
  const result = response.result;
  if (!result) return { ok: false, error: "the daemon returned no result" };
  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? "the browser could not complete the action",
      stateToken: result.stateToken,
      output: result.output,
    };
  }
  return {
    ok: true,
    output: result.output,
    stateToken: result.stateToken,
    settled: result.settled,
  };
}

/** Does this result carry the daemon's post-handoff note? (`daemon/lease.ts`) */
function carriesHandoffNote(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    typeof (output as { handoffNote?: unknown }).handoffNote === "string"
  );
}

function transportError(status: string): string {
  switch (status) {
    case "busy":
      return "busy: another browser action is already running on this tab; try again in a moment";
    case "at_capacity":
      return "at_capacity: the browser daemon is saturated and should be restarted";
    case "unknown_boot":
      return "unknown_boot: the browser restarted, so this action was not replayed; re-observe and try again";
    case "expired":
      return "expired: this action sat too long to be run safely; issue it again";
    default:
      return `the browser daemon rejected the command (${status})`;
  }
}

/** Per-turn state: one session, and the last token seen per tab (L3). */
class BrowserTurnState {
  private session: Promise<BrowserSessionHandle> | null = null;
  private readonly tokens = new Map<string, ObservationStateToken>();
  /** Set when a human held the browser; forces a fresh look (W4's L6). */
  private staleAfterHandoff = false;

  constructor(
    private readonly opts: BrowserToolsOptions,
    private readonly ensure: NonNullable<BrowserToolsOptions["ensureSession"]>,
    private readonly contextMode: BrowserContextMode,
    private readonly ownerKey: string | undefined,
  ) {}

  /** Ensure lazily: a turn that never calls a browser tool boots nothing. */
  handle(signal?: AbortSignal): Promise<BrowserSessionHandle> {
    this.session ??= this.ensure({
      bearer: this.opts.authHeader,
      projectId: this.opts.projectId,
      contextMode: this.contextMode,
      ...(this.ownerKey ? { ownerKey: this.ownerKey } : {}),
      ...(signal ? { signal } : {}),
    });
    return this.session;
  }

  rememberToken(tabId: string | undefined, token?: ObservationStateToken): void {
    if (!token) return;
    this.tokens.set(tabId ?? "@session", token);
    // A token minted AFTER the handoff describes the page as it is now, so the
    // turn is caught up. Leaving the flag set would disable L3 for the rest of
    // the turn — the opposite of what the loud resume is for.
    this.staleAfterHandoff = false;
  }

  /**
   * The token an act should be pinned to. Models never see or carry tokens —
   * this layer threads the one from the observation the model actually acted
   * on, which is what makes L3 protect against stale targeting rather than
   * being a parameter a model can forget.
   */
  tokenFor(tabId: string | undefined): ObservationStateToken | undefined {
    if (this.staleAfterHandoff) return undefined;
    return this.tokens.get(tabId ?? "@session");
  }

  /**
   * Drop every cached page token (W4/L6). Called when a person took the
   * browser: whatever this turn observed before the handoff describes a page
   * that a human has since navigated, logged into, or closed. Acting on it is
   * exactly the mistake L3 exists to prevent, and unlike a normal DOM shift
   * the daemon cannot detect this one for us — the tokens we hold are still
   * internally consistent, just about the wrong moment.
   */
  forgetTokens(): void {
    this.tokens.clear();
    this.staleAfterHandoff = true;
  }

  get handoffPending(): boolean {
    return this.staleAfterHandoff;
  }
}

/**
 * Pages that are not anywhere.
 *
 * `about:blank` is every tab's first history entry, so a `back` out of the one
 * page a run visited lands on it — and its origin is the opaque string
 * `"null"`, which matches no allowlist entry and cannot be parsed as a URL.
 * Judged as a violation it produces the worst possible answer: the run is told
 * "the page moved somewhere this policy does not permit" about a blank page it
 * was sent to by its own recovery, and is sent back again. It carries no
 * content and no cookies, so there is nothing an allowlist could protect.
 */
const NEUTRAL_URLS = new Set(["about:blank", "about:srcdoc", ""]);

function isOriginAllowed(
  url: string,
  allowlist: readonly string[] | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (NEUTRAL_URLS.has(url)) return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (trimmed === origin) return true;
    // A bare host is accepted as "any scheme on this host", which is what an
    // operator writing `example.com` means.
    try {
      return new URL(origin).hostname === trimmed;
    } catch {
      return false;
    }
  });
}

/**
 * Build the browser toolset for a turn, or NOTHING when this surface has not
 * attested how approval reaches the user (see the module docstring).
 */
export function buildBrowserTools(
  opts: BrowserToolsOptions,
): BrowserToolsResult | undefined {
  const delivery = opts.approvalDelivery;
  if (!delivery) {
    // The fail-closed default that keeps every unthreaded surface safe.
    logger.warn(
      "[built-in-tools] browser tools not advertised: this surface did not attest approval delivery",
      { projectId: opts.projectId },
    );
    opts.onToolSuppressed?.({
      id: BROWSER_BUILT_IN_TOOL_ID,
      reason:
        "browser tools need an approval path: an interactive surface must thread the " +
        "approval classification, and an unattended run must declare a toolPolicy.",
    });
    return undefined;
  }

  const unattended = delivery.kind === "unattended" ? delivery.policy : null;
  const readOnly = unattended?.mode === "read_only";
  const engine: BrowserEngine = opts.engine ?? "hosted";
  // DERIVED, never configured. A surface that can ask a person is interactive
  // and keeps its logins; one that cannot is unattended and must start blank.
  // Letting these be set independently is how an eval ends up running against
  // whatever profile the last playground session left signed in.
  const contextMode: BrowserContextMode = unattended ? "ephemeral" : "persistent";
  // Ephemeral browsers are keyed per RUN. Falling back to the project (or to
  // the swarm, which fans out many runs) is what let two unattended runs share
  // one browser and one cookie jar — so a run that cannot name itself gets no
  // browser at all rather than somebody else's session.
  const ownerKey = unattended ? unattendedOwnerKey(opts) : undefined;
  if (unattended && !ownerKey) {
    logger.warn(
      "[built-in-tools] browser tools not advertised: unattended run did not name itself",
      { projectId: opts.projectId },
    );
    opts.onToolSuppressed?.({
      id: BROWSER_BUILT_IN_TOOL_ID,
      reason:
        "an unattended browser must name the run it belongs to, so two runs " +
        "cannot share one throwaway profile",
    });
    return undefined;
  }
  const state = new BrowserTurnState(
    opts,
    opts.ensureSession ?? defaultEnsureSession(engine),
    contextMode,
    ownerKey,
  );

  // An unattended `allowlist` policy may name the exact tools this run may
  // use; anything else gets every tool, with approval as the gate.
  const allowedNames = new Set(
    unattended?.mode === "allowlist" && unattended.toolAllowlist?.length
      ? unattended.toolAllowlist
      : BROWSER_TOOL_NAMES,
  );
  // A read-only run gets ONLY the tools that look. Refusing to build the rest
  // is stronger than gating them: with nobody to ask, an ungated interactive
  // tool would simply run.
  const names = BROWSER_TOOL_NAMES.filter((name) => {
    if (!allowedNames.has(name)) return false;
    if (readOnly && !isObservational(name)) return false;
    return true;
  });
  if (names.length === 0) {
    opts.onToolSuppressed?.({
      id: BROWSER_BUILT_IN_TOOL_ID,
      reason: "the declared browser toolPolicy leaves no usable tools",
    });
    return undefined;
  }

  // Local is forced to ask, exactly as `bash` is (bash.ts:131). The browser is
  // driving a real, signed-in Chromium on someone's own machine, where the
  // blast radius of an unreviewed click is their accounts rather than a
  // disposable box.
  const needsApproval = delivery.kind === "attested" || engine === "local";
  const send = async (
    action: BrowserAction,
    args: {
      tabId?: string;
      signal?: AbortSignal;
      expectedState?: boolean;
      /** Set on the one navigation issued to LEAVE a disallowed origin. */
      recovering?: boolean;
    },
  ): Promise<CommandOutcome & { tabId: string }> => {
    const handle = await state.handle(args.signal);
    const recovering = args.recovering === true;
    const tabId = args.tabId ?? "@session";
    const pinned = args.expectedState ? state.tokenFor(args.tabId) : undefined;
    const command: BrowserCommand = {
      commandId: randomUUID(),
      source: unattended ? "eval" : "chat",
      ...(args.tabId ? { tabId: args.tabId } : {}),
      action:
        pinned && action.kind === "act"
          ? { ...action, expectedState: pinned }
          : action,
    };
    const response = await (handle.client as unknown as CommandSender).sendCommand(
      command,
      handle.bootId,
    );
    let outcome = unwrapCommand(response);
    // W4/L6 — a handoff invalidates everything this turn cached. Two signals
    // reach us: a refusal while the person still holds the browser, and the
    // note the daemon attaches to the first result after they hand it back.
    // Order matters: forget BEFORE remembering, so the fresh token from the
    // post-handoff observation survives and the turn is immediately caught up.
    if (response.status === "lease_blocked" || carriesHandoffNote(outcome.output)) {
      state.forgetTokens();
    }
    // ORIGIN, ENFORCED ON THE RESULT (not just on the request).
    //
    // Checking the URL a model ASKS for stops it navigating somewhere the
    // policy never named. It does not stop the page taking it there: a
    // redirect, a meta refresh, a link the model clicked, an OAuth bounce.
    // Until now the observation of that page came back in full, which made the
    // allowlist a suggestion to the model rather than a boundary on the run.
    if (unattended?.originAllowlist?.length) {
      outcome = await enforceResultOrigin(outcome, {
        allowlist: unattended.originAllowlist,
        tabId: args.tabId,
        recover: recovering
          ? undefined
          : (action) => send(action, { ...args, recovering: true }),
      });
    }
    state.rememberToken(args.tabId, outcome.stateToken);
    return { ...outcome, tabId };
  };

  const tools: ToolSet = {};
  const built: string[] = [];
  const add = (name: string, definition: ToolSet[string]) => {
    if (!names.includes(name)) return;
    // Attached HERE, once, rather than on each tool: every one of these
    // returns a `present()` shape and so may carry a capture, and a tool added
    // later that forgot the mapping would silently go back to sending the
    // model an unreadable base64 string.
    tools[name] = { ...definition, toModelOutput: toBrowserModelOutput };
    built.push(name);
  };

  add(
    "browser_navigate",
    tool({
      description:
        `Open a URL in ${engineLabel(engine)} (or go back / reload). Returns what the page ` +
        "looks like after it settles, so you do not need to observe separately.",
      inputSchema: z.object({
        url: z.string().optional().describe("URL to open. Omit when using back or reload."),
        action: z
          .enum(["goto", "back", "reload"])
          .optional()
          .describe("Defaults to goto."),
        tabId: z.string().optional().describe("Tab to drive. Omit for the main tab."),
        newTab: z
          .boolean()
          .optional()
          .describe("Open in a NEW tab; requires an unused tabId."),
      }),
      needsApproval,
      execute: async ({ url, action, tabId, newTab }, { abortSignal }) => {
        const verb = action ?? "goto";
        if (verb === "goto" && !url) return { error: "navigate needs a url" };
        if (url && unattended && !isOriginAllowed(url, unattended.originAllowlist)) {
          // Enforced BEFORE the command leaves this process: an unattended run
          // must not reach an origin its policy never named.
          return {
            error:
              `origin_not_allowed: this run's toolPolicy does not permit ${url} — ` +
              `allowed origins: ${(unattended.originAllowlist ?? []).join(", ") || "(none)"}`,
          };
        }
        const browserAction: BrowserAction =
          verb === "goto"
            ? { kind: "navigate", url: url!, ...(newTab ? { newTab: true } : {}) }
            : verb === "back"
              ? { kind: "back" }
              : { kind: "reload" };
        return present(await send(browserAction, { tabId, signal: abortSignal }));
      },
    }),
  );

  add(
    "browser_act",
    tool({
      description:
        "Interact with the page: click, type, press a key, scroll, hover, drag or select. " +
        "Target by coordinates from the last screenshot, or by CSS selector. Returns the " +
        "page state after the action settles. Coordinates are CSS pixels in a " +
        `${VIEWPORT_W}x${VIEWPORT_H} viewport with (0, 0) at the TOP-LEFT of the ` +
        "screenshot — the screenshot is always shown at that size, so read x and y " +
        "straight off it without scaling.",
      inputSchema: z.object({
        verb: z.enum([
          "click",
          "type",
          "press",
          "scroll",
          "hover",
          "drag",
          "select",
        ]),
        selector: z.string().optional().describe("CSS selector to target."),
        x: z
          .number()
          .min(0)
          .max(VIEWPORT_W - 1)
          .optional()
          .describe(
            `X coordinate from the last screenshot, 0 to ${VIEWPORT_W - 1}.`,
          ),
        y: z
          .number()
          .min(0)
          .max(VIEWPORT_H - 1)
          .optional()
          .describe(
            `Y coordinate from the last screenshot, 0 to ${VIEWPORT_H - 1}.`,
          ),
        value: z
          .string()
          .optional()
          .describe(
            'Text to type, key to press ("Enter"), scroll amount ("down"/"up"/pixels), ' +
              'drag destination ("x,y" in the same viewport coordinates), or option ' +
              "value to select.",
          ),
        tabId: z.string().optional(),
      }),
      needsApproval,
      execute: async ({ verb, selector, x, y, value, tabId }, { abortSignal }) => {
        if (x !== undefined && y !== undefined && !isPointInViewport(x, y)) {
          // The schema states the bounds, but a hosted path reconstructs the
          // schema on the wire and executes with whatever input comes back, so
          // the bound is re-checked here rather than assumed. The daemon
          // refuses too; this one exists to answer the model in its own terms
          // instead of as a transport error.
          return {
            error:
              `out_of_viewport: (${x}, ${y}) is outside the ${VIEWPORT_W}x${VIEWPORT_H} ` +
              "screenshot; nothing was clicked. Coordinates are CSS pixels with " +
              "(0, 0) at the top-left — re-read the screenshot and pick a point inside it.",
          };
        }
        const target: BrowserActTarget | undefined =
          x !== undefined && y !== undefined
            ? { coordinates: [x, y] }
            : selector
              ? { selector }
              : undefined;
        return present(
          await send(
            {
              kind: "act",
              verb,
              ...(target ? { target } : {}),
              ...(value !== undefined ? { value } : {}),
            },
            // Pin to the observation the model actually saw (L3).
            { tabId, signal: abortSignal, expectedState: true },
          ),
        );
      },
    }),
  );

  add(
    "browser_tabs",
    tool({
      description:
        "Manage browser tabs: activate one, or close one. Open a new tab with " +
        "browser_navigate({newTab:true, tabId:'<new name>'}).",
      inputSchema: z.object({
        action: z.enum(["activate", "close"]),
        tabId: z.string().describe("The tab to act on."),
      }),
      needsApproval,
      execute: async ({ action, tabId }, { abortSignal }) =>
        present(
          await send(
            { kind: "act", verb: action === "activate" ? "activate_tab" : "close_tab" },
            { tabId, signal: abortSignal },
          ),
        ),
    }),
  );

  add(
    "browser_observe",
    tool({
      description:
        "Look at the page: a screenshot, the DOM outline, the accessibility tree, the " +
        "console tail, or just the URL. Use this to re-read a page you have not acted on.",
      inputSchema: z.object({
        mode: z
          .enum(["screenshot", "dom", "a11y", "console", "url"])
          .optional()
          .describe("Defaults to screenshot."),
        rootSelector: z
          .string()
          .optional()
          .describe(
            'With mode "a11y": read only the subtree under this CSS selector. ' +
              "Use it to read a subtree an earlier observation reported as omitted.",
          ),
        tabId: z.string().optional(),
      }),
      needsApproval: needsApproval && !readOnly,
      execute: async ({ mode, rootSelector, tabId }, { abortSignal }) =>
        present(
          await send(
            {
              kind: "observe",
              mode: mode ?? "screenshot",
              ...(rootSelector ? { rootSelector } : {}),
            },
            { tabId, signal: abortSignal },
          ),
        ),
    }),
  );

  add(
    "browser_webmcp_tools",
    tool({
      description:
        "List the WebMCP tools the current page offers, if any. Pages that expose tools " +
        "let you act through their own API instead of clicking; most pages offer none.",
      inputSchema: z.object({ tabId: z.string().optional() }),
      needsApproval: needsApproval && !readOnly,
      execute: async ({ tabId }, { abortSignal }) =>
        present(
          await send(
            { kind: "observe", mode: "webmcp_tools" },
            { tabId, signal: abortSignal },
          ),
        ),
    }),
  );

  add(
    "browser_webmcp_invoke",
    tool({
      description:
        "Call one of the WebMCP tools the current page offers (see browser_webmcp_tools).",
      inputSchema: z.object({
        toolName: z.string(),
        input: z.unknown().optional(),
        tabId: z.string().optional(),
      }),
      needsApproval,
      execute: async ({ toolName, input, tabId }, { abortSignal }) => {
        if (
          unattended?.mode === "allowlist" &&
          unattended.toolAllowlist?.length &&
          !unattended.toolAllowlist.includes(`webmcp:${toolName}`)
        ) {
          return {
            error:
              `tool_not_allowed: this run's toolPolicy does not permit the page tool ` +
              `"${toolName}"`,
          };
        }
        return present(
          await send(
            { kind: "webmcp_invoke", toolKey: toolName, input },
            { tabId, signal: abortSignal },
          ),
        );
      },
    }),
  );

  return {
    tools,
    approvals: classifyBrowserToolApprovals(built, { readOnly }),
  };
}

/**
 * What the model should call this browser.
 *
 * Not decoration: a model that believes it is driving a disposable cloud box
 * reasons differently about signing in and about side effects than one that
 * knows the browser is the user's own.
 */
function engineLabel(engine: BrowserEngine): string {
  return engine === "local"
    ? "the browser on this machine (the user's own, with their logins)"
    : "the cloud browser";
}

/**
 * What an unattended run calls itself, for keying its throwaway browser.
 *
 * The scope is a prefix, not the identity: it keeps two runs of the same id in
 * different swarms apart, but only `runKey` says WHICH run this is. Undefined
 * when the caller supplied none — the caller then advertises no browser.
 */
function unattendedOwnerKey(opts: BrowserToolsOptions): string | undefined {
  const run = opts.runKey?.trim();
  if (!run) return undefined;
  const scope = opts.executionScope;
  return scope?.kind === "swarm" ? `swarm:${scope.swarmId}:${run}` : run;
}

/** The session path for an engine — the ONE seam between the two. */
function defaultEnsureSession(
  engine: BrowserEngine,
): NonNullable<BrowserToolsOptions["ensureSession"]> {
  if (engine === "local") {
    return async ({ projectId, contextMode, ownerKey }) =>
      ensureLocalBrowserSession({
        projectId,
        contextMode,
        ...(ownerKey ? { ownerKey } : {}),
      });
  }
  return ensureLiveBrowserSession;
}

/**
 * Strip an observation that landed off-allowlist, and get off the page.
 *
 * Two halves, and both matter. The strip is the boundary: a screenshot of a
 * page the run was never permitted to visit is exactly the leak the allowlist
 * exists to prevent, and it is already in this process by the time we look.
 * The recovery navigation is what stops the run WEDGING there — every
 * subsequent observation would otherwise be refused for the same reason, with
 * the model unable to act because acting is also refused.
 *
 * The recovery is issued once (`recovering`), never in a loop: if going back
 * lands somewhere equally disallowed, the model is told and left to decide,
 * rather than the run walking history until it runs out.
 */
async function enforceResultOrigin(
  outcome: CommandOutcome,
  args: {
    allowlist: readonly string[];
    tabId?: string;
    recover?: (action: BrowserAction) => Promise<unknown>;
  },
): Promise<CommandOutcome> {
  const url = resultUrl(outcome.output);
  if (!url || isOriginAllowed(url, args.allowlist)) return outcome;

  await args.recover?.({ kind: "back" });
  return {
    ok: false,
    error:
      `origin_not_allowed: the page moved to ${url}, which this run's ` +
      "toolPolicy does not permit — the page was NOT read, and the browser " +
      "has been sent back. Allowed origins: " +
      `${args.allowlist.join(", ")}`,
    ...(outcome.stateToken ? { stateToken: outcome.stateToken } : {}),
  };
}

/** The URL a result describes, from wherever this shape carries one. */
function resultUrl(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const top = (output as { url?: unknown }).url;
  if (typeof top === "string") return top;
  const page = (output as { page?: unknown }).page;
  if (typeof page === "object" && page !== null) {
    const nested = (page as { url?: unknown }).url;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function isObservational(name: string): boolean {
  return name === "browser_observe" || name === "browser_webmcp_tools";
}

/**
 * Shape a daemon outcome for the model. Errors are returned (not thrown) so a
 * failure is something the model can read and respond to, exactly like the
 * bash tool — and the state token never reaches it, because it is this
 * layer's bookkeeping, not the model's.
 */
/** One model-visible content part, as the AI SDK tool-result contract takes them. */
type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image-data"; data: string; mediaType: string };

/**
 * Sniff the capture format from its base64 prefix. Mirrors the helper in
 * `computer-use-tool.ts`; kept local rather than imported because that module
 * pulls the Anthropic provider and the widget harness in with it, and this is
 * two lines of magic-number matching.
 */
function imageMediaType(base64: string): string {
  // JPEG base64 begins with "/9j/"; PNG with "iVBOR".
  return base64.startsWith("/9j/") ? "image/jpeg" : "image/png";
}

/**
 * Lift the screenshot out of a result and hand it to the model as IMAGE
 * content, with everything else alongside as text.
 *
 * The capture is pulled from the top level (a normal observation) and from the
 * `page` envelope (the fresh observation that rides a `stale_observation`
 * refusal) — the second is precisely when the model most needs to see what the
 * page became. It is REMOVED from the text half rather than duplicated: a
 * base64 blob repeated as text is the token cost this mapping exists to avoid.
 */
export function toBrowserModelOutput({ output }: { output: unknown }): {
  type: "content";
  value: ModelContentPart[];
} {
  const value: ModelContentPart[] = [];
  if (typeof output !== "object" || output === null) {
    return {
      type: "content",
      value: [{ type: "text", text: JSON.stringify(output ?? null) }],
    };
  }
  const rest: Record<string, unknown> = { ...(output as Record<string, unknown>) };
  const shot = takeScreenshot(rest);
  if (shot) {
    value.push({ type: "image-data", data: shot, mediaType: imageMediaType(shot) });
  }
  value.push({ type: "text", text: JSON.stringify(rest) });
  return { type: "content", value };
}

/**
 * Remove and return the capture, from wherever this result carries one.
 * Mutates `rest` (and its `page` envelope, copied first so the caller's
 * object is never rewritten).
 */
function takeScreenshot(rest: Record<string, unknown>): string | undefined {
  const top = rest.screenshot;
  if (typeof top === "string" && top.length > 0) {
    delete rest.screenshot;
    return top;
  }
  const page = rest.page;
  if (typeof page === "object" && page !== null) {
    const nested = { ...(page as Record<string, unknown>) };
    const shot = nested.screenshot;
    if (typeof shot === "string" && shot.length > 0) {
      delete nested.screenshot;
      rest.page = nested;
      return shot;
    }
  }
  return undefined;
}

function present(
  outcome: CommandOutcome & { tabId: string },
): Record<string, unknown> {
  if (!outcome.ok) {
    return {
      error: outcome.error,
      ...(outcome.output !== undefined ? { page: outcome.output } : {}),
    };
  }
  return {
    ...(typeof outcome.output === "object" && outcome.output !== null
      ? (outcome.output as Record<string, unknown>)
      : { result: outcome.output }),
    ...(outcome.settled === false
      ? {
          settled: false,
          note: "the page was still loading when this was captured; observe again if it looks incomplete",
        }
      : {}),
  };
}
