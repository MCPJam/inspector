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
 *   2. BOTH LAYERS ARE CHECKED on every daemon reply. A command can be
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
import type {
  BrowserAction,
  BrowserActTarget,
  BrowserCommand,
  ObservationStateToken,
} from "../../services/browserd/protocol.js";
import type { BrowserSessionHandle } from "../../services/browserd/browser-session.js";
import { ensureLiveBrowserSession } from "../../services/browserd/live-session-deps.js";

export const BROWSER_BUILT_IN_TOOL_ID = "browser";

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
  /** Project whose desktop computer this turn drives. */
  projectId: string;
  executionScope?: ExecutionScope;
  /** ABSENT ⇒ nothing is built. See the fail-closed note above. */
  approvalDelivery?: BrowserApprovalDelivery;
  /** Injectable for tests; defaults to the live E2B/Convex session path. */
  ensureSession?: (args: {
    bearer: string;
    projectId: string;
    signal?: AbortSignal;
  }) => Promise<BrowserSessionHandle>;
  /** Surfaced to the run when a tool is deliberately not advertised. */
  onToolSuppressed?: (info: { id: string; reason: string }) => void;
}

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
  ) {}

  /** Ensure lazily: a turn that never calls a browser tool boots nothing. */
  handle(signal?: AbortSignal): Promise<BrowserSessionHandle> {
    this.session ??= this.ensure({
      bearer: this.opts.authHeader,
      projectId: this.opts.projectId,
      ...(signal ? { signal } : {}),
    });
    return this.session;
  }

  rememberToken(tabId: string | undefined, token?: ObservationStateToken): void {
    if (token) this.tokens.set(tabId ?? "@session", token);
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

  forgetTokens(): void {
    this.tokens.clear();
    this.staleAfterHandoff = true;
  }
}

function isOriginAllowed(
  url: string,
  allowlist: readonly string[] | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
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
  const state = new BrowserTurnState(opts, opts.ensureSession ?? ensureLiveBrowserSession);

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

  const needsApproval = delivery.kind === "attested";
  const send = async (
    action: BrowserAction,
    args: { tabId?: string; signal?: AbortSignal; expectedState?: boolean },
  ): Promise<CommandOutcome & { tabId: string }> => {
    const handle = await state.handle(args.signal);
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
    const outcome = unwrapCommand(response);
    state.rememberToken(args.tabId, outcome.stateToken);
    return { ...outcome, tabId };
  };

  const tools: ToolSet = {};
  const built: string[] = [];
  const add = (name: string, definition: ToolSet[string]) => {
    if (!names.includes(name)) return;
    tools[name] = definition;
    built.push(name);
  };

  add(
    "browser_navigate",
    tool({
      description:
        "Open a URL in the cloud browser (or go back / reload). Returns what the page " +
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
        "page state after the action settles.",
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
        x: z.number().optional().describe("X coordinate from the last screenshot."),
        y: z.number().optional().describe("Y coordinate from the last screenshot."),
        value: z
          .string()
          .optional()
          .describe(
            'Text to type, key to press ("Enter"), scroll amount ("down"/"up"/pixels), ' +
              'drag destination ("x,y"), or option value to select.',
          ),
        tabId: z.string().optional(),
      }),
      needsApproval,
      execute: async ({ verb, selector, x, y, value, tabId }, { abortSignal }) => {
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
        tabId: z.string().optional(),
      }),
      needsApproval: needsApproval && !readOnly,
      execute: async ({ mode, tabId }, { abortSignal }) =>
        present(
          await send(
            { kind: "observe", mode: mode ?? "screenshot" },
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

function isObservational(name: string): boolean {
  return name === "browser_observe" || name === "browser_webmcp_tools";
}

/**
 * Shape a daemon outcome for the model. Errors are returned (not thrown) so a
 * failure is something the model can read and respond to, exactly like the
 * bash tool — and the state token never reaches it, because it is this
 * layer's bookkeeping, not the model's.
 */
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
