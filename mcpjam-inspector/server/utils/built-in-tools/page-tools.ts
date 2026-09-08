/**
 * A page's WebMCP tools, as FIRST-CLASS model tools.
 *
 * The model used to reach a page's tools through two generic verbs: list them
 * with `browser_webmcp_tools`, then call one by name through
 * `browser_webmcp_invoke` with an untyped `input` blob. That was two wasted
 * round trips per page and an argument nobody checks — `input` was
 * `z.unknown()`, Chrome does not validate an invocation against the registered
 * `inputSchema` (WebMCP spec issue #92), and the page's `execute` is handed
 * whatever arrived. On the pizza-maker demo the model's invoke failed twice
 * and it fell back to clicking.
 *
 * The list verb is gone entirely (every observation now reports what the page
 * has); the invoke verb survives only where a turn cannot grow its tool set.
 *
 * Here each page tool is its own tool: real name, the page's own schema
 * advertised verbatim, arguments validated before any command leaves this
 * process, an ordinary approval pill, and a binding that says WHICH
 * registration on WHICH document generation the model is calling.
 *
 * SERVER-EXECUTED, like the `browser_*` verbs and unlike `page_*`/`ui_*`. The
 * distinction is decided solely by `typeof tool.execute === "function"`
 * (`shared/http-tool-calls.ts`), and the `page_`/`ui_`/`app_` prefixes mean
 * "the BROWSER fulfils this". A page can register a tool literally called
 * `page_abcd1234`, so the `webmcp_` prefix is not decoration: a page tool
 * wearing a client-fulfilled name would leave the stream waiting forever on a
 * result nobody sends.
 *
 * TWO THINGS ARE STRUCTURAL:
 *
 *   1. EVERY PAGE TOOL IS CLASSIFIED. Approval on the hosted engines is keyed
 *      by NAME from `uiToolApprovals`, and a name that appears in neither set
 *      falls through to `requireToolApproval` — off by default. An
 *      unclassified `webmcp_*` name would therefore run third-party code on a
 *      signed-in browser with no pill at all. The classification is returned
 *      from this builder rather than derived somewhere else so it cannot be
 *      forgotten, and `mcpjam-stream-handler.test.ts` pins the ungated
 *      behaviour that makes it mandatory.
 *
 *   2. PAGE ANNOTATIONS ARE NEVER READ. A page's `readOnly` is a claim by the
 *      party whose code would run, and Chromium does not carry annotations
 *      through for imperative registrations at all — so `readOnly: false` on
 *      one of those is the absence of a signal, not a claim. Everything gates.
 *      See `pageToolCallNeedsApproval`.
 */
import { jsonSchema, tool, type ToolSet } from "ai";
import {
  pageToolCallNeedsApproval,
  type BrowserUnattendedPolicy,
  type UiToolApprovalClassification,
} from "@/shared/client-fulfilled-tools";
import {
  WEBMCP_MAX_PAGE_TOOLS,
  WEBMCP_TOOL_NAME_PREFIX,
  declaredToolsFromWebmcp,
  mintDeclaredToolNames,
  toProviderToolSchema,
  validateDeclaredArgs,
  type DeclaredToolProvider,
  type MintedDeclaredTool,
} from "@/shared/declared-tools";
import type { BrowserPageTool } from "@/shared/browser-page-tools";
import type {
  BrowserAction,
  WebMcpToolBinding,
} from "../../services/browserd/protocol.js";

/**
 * One page tool as the peek reported it.
 *
 * An alias rather than a second shape: `BrowserPageTool` carries `frameId` and
 * `registrationSeq` precisely because this builder needs them, and a parallel
 * type here would be a second place for the pane and the model to disagree
 * about what a page declared.
 */
export type PeekedPageTool = BrowserPageTool;

/** What a page-tool `execute` needs from the browser layer. */
export type PageToolSend = (
  action: BrowserAction,
  args: { tabId?: string; signal?: AbortSignal },
) => Promise<Record<string, unknown>>;

export interface BuildWebmcpPageToolsOptions {
  pageTools: readonly PeekedPageTool[];
  /** Issues the daemon command and shapes the result, exactly as a verb does. */
  send: PageToolSend;
  /** The unattended run's declared policy, when nobody is watching. */
  policy?: BrowserUnattendedPolicy | null;
  /** Per-tool gate for engines that read it (BYOK). */
  needsApproval: boolean;
  /** Identity every minted tool binds to. */
  binding: Pick<WebMcpToolBinding, "bootId" | "tabId" | "navCounter">;
  /**
   * Names already taken by something else this turn.
   *
   * A page tool LOSES a collision and is dropped. The alternative — renaming
   * it out of the way — would let a page decide what an MCP server's tool is
   * called, and the model has no way to tell which of the two it just called.
   */
  reservedNames?: ReadonlySet<string>;
  /** Which provider's schema subset to report against. */
  provider?: DeclaredToolProvider;
  /** Hard ceiling on advertised page tools. */
  maxTools?: number;
  /** Called for each tool NOT advertised, with the reason the pane shows. */
  onDropped?: (info: { rawName: string; name: string; reason: string }) => void;
}

export interface WebmcpPageToolsResult {
  tools: ToolSet;
  /** For the caller to merge into the engine's single `uiToolApprovals` slot. */
  approvals: UiToolApprovalClassification;
  /** What was actually advertised, in advertised order. */
  minted: MintedDeclaredTool[];
  /** Model name → the tool it came from, for attribution and the pane. */
  index: Map<string, MintedDeclaredTool>;
}

/**
 * Bound on how many of a page's tools reach the model at once.
 *
 * A page may register any number. Every advertised tool is re-serialized into
 * EVERY step of the turn, so an unbounded set is a page deciding how much of
 * the context window the conversation gets — and the tools past the first few
 * dozen are not ones a model was going to pick anyway.
 */
export { WEBMCP_MAX_PAGE_TOOLS };

/**
 * The attribution that rides inside a page tool's result.
 *
 * IN THE RESULT, not in a side table. A tool result is message content, so it
 * persists in the transcript for free and is still there when the conversation
 * is reopened tomorrow — by which time the live tool set describes whatever
 * page the browser is on now. A card attributed from the live store would
 * change its own history.
 */
export interface PageToolResultAttribution {
  rawName: string;
  origin?: string;
  frameId?: string;
  navCounter: number;
  registrationSeq?: number;
}

/**
 * Build the `webmcp_*` toolset for one document generation.
 *
 * Returns an empty set rather than undefined when nothing qualifies: "this
 * page offers no tools" is the common case, not a failure, and a caller that
 * had to distinguish the two would branch on it everywhere.
 */
export function buildWebmcpPageTools(
  options: BuildWebmcpPageToolsOptions,
): WebmcpPageToolsResult {
  const empty: WebmcpPageToolsResult = {
    tools: {},
    approvals: { requiredNames: new Set(), freeNames: new Set() },
    minted: [],
    index: new Map(),
  };
  const policy = options.policy ?? null;
  // A READ-ONLY run advertises NONE. Refusing to build them is stronger than
  // gating them: with nobody to ask, an ungated interactive tool simply runs —
  // and there is no such thing as an observational page tool. A page's
  // `readOnly` annotation is a claim by the party whose code would run, so it
  // cannot be the thing that promotes one.
  if (policy?.mode === "read_only") {
    for (const pageTool of options.pageTools) {
      options.onDropped?.({
        rawName: pageTool.name,
        name: "",
        reason:
          "this run declared a read_only toolPolicy, and a page tool cannot be " +
          "read-only on the page's word alone",
      });
    }
    return empty;
  }

  const allowlist =
    policy?.mode === "allowlist" && policy.toolAllowlist?.length
      ? new Set(policy.toolAllowlist)
      : null;

  const minted = mintDeclaredToolNames(
    WEBMCP_TOOL_NAME_PREFIX,
    declaredToolsFromWebmcp(options.pageTools),
  );

  const tools: ToolSet = {};
  const index = new Map<string, MintedDeclaredTool>();
  const requiredNames = new Set<string>();
  const cap = options.maxTools ?? WEBMCP_MAX_PAGE_TOOLS;
  const advertised: MintedDeclaredTool[] = [];

  for (const pageTool of minted) {
    const drop = (reason: string) =>
      options.onDropped?.({
        rawName: pageTool.rawName,
        name: pageTool.name,
        reason,
      });

    if (advertised.length >= cap) {
      drop(
        `this page declares more than ${cap} tools; this one is past the cap`,
      );
      continue;
    }
    // AT BUILD TIME, not at execute: a run must not be shown a tool whose
    // every call would be a refusal, and an allowlist entry names the page's
    // OWN tool name (`webmcp:getAvailability`), not the minted one — an
    // operator writing a policy has the page in front of them, not our
    // sanitizer.
    if (allowlist && !allowlist.has(`webmcp:${pageTool.rawName}`)) {
      drop("this run's toolPolicy does not list this page tool");
      continue;
    }
    if (
      policy?.originAllowlist?.length &&
      !isOriginAllowed(pageTool.origin, policy.originAllowlist)
    ) {
      drop(
        `this run's toolPolicy does not permit ${pageTool.origin ?? "this origin"}`,
      );
      continue;
    }
    if (options.reservedNames?.has(pageTool.name)) {
      drop(
        `another tool in this turn is already called ${pageTool.name}; the page's ` +
          "tool is dropped rather than renamed, so a call to that name is never ambiguous",
      );
      continue;
    }
    // NO IDENTITY, NO FIRST-CLASS TOOL.
    //
    // A binding is the whole reason one of these can be advertised as an
    // ordinary tool: it says which registration in which frame on which
    // generation of which document the approval was granted against, and the
    // daemon refuses the invocation when any of that has moved. Building the
    // tool anyway and simply omitting the binding does not degrade to "less
    // safe" — it degrades to the daemon resolving the tool BY NAME at call
    // time, which is precisely the silent substitution this design exists to
    // prevent, wearing a typed schema and an approval pill that say otherwise.
    //
    // A daemon too old to send `frameId` and `registrationSeq` therefore gets
    // the generic verbs instead, where an untyped by-name call is at least
    // honest about being one.
    if (
      pageTool.frameId === undefined ||
      pageTool.registrationSeq === undefined
    ) {
      drop(
        "this browser did not say which frame and registration declared this " +
          "tool, so a call to it could not be bound to the document it was " +
          "listed on",
      );
      continue;
    }
    const provider = toProviderToolSchema(
      pageTool.inputSchema,
      options.provider ?? "generic",
    );
    const diagnostics = [...pageTool.diagnostics, ...provider.diagnostics];
    const blocking = diagnostics.find((diagnostic) => diagnostic.blocking);
    if (blocking) {
      drop(blocking.message);
      continue;
    }
    const decorated: MintedDeclaredTool = { ...pageTool, diagnostics };
    advertised.push(decorated);
    index.set(pageTool.name, decorated);
    // EVERY page tool gates. Not `needsApproval && something`: there is
    // nothing trustworthy to relax on, and this classification is what the
    // hosted engines read.
    if (pageToolCallNeedsApproval()) requiredNames.add(pageTool.name);
    tools[pageTool.name] = buildOne(decorated, options);
  }

  return {
    tools,
    approvals: { requiredNames, freeNames: new Set<string>() },
    minted: advertised,
    index,
  };
}

function buildOne(
  pageTool: MintedDeclaredTool,
  options: BuildWebmcpPageToolsOptions,
): ToolSet[string] {
  // ALWAYS PRESENT. `buildWebmcpPageTools` drops a tool it cannot bind rather
  // than reaching here without one — see the drop beside `reservedNames`.
  const binding: WebMcpToolBinding = {
    bootId: options.binding.bootId,
    tabId: options.binding.tabId,
    navCounter: options.binding.navCounter,
    frameId: pageTool.frameId!,
    registrationSeq: pageTool.registrationSeq!,
  };

  return tool({
    description: pageTool.description,
    // THE PAGE'S SCHEMA, VERBATIM. `jsonSchema` hands the AI SDK a raw JSON
    // Schema rather than a Zod shape, which is the only way to pass through a
    // `oneOf` of `const`s (Chrome's own example) without re-expressing it in a
    // vocabulary that cannot hold it. Validation happens below against this
    // same object, so the contract the model reads is the contract we check.
    inputSchema: jsonSchema<Record<string, unknown>>(
      (pageTool.inputSchema ?? {
        type: "object",
        properties: {},
      }) as never,
    ),
    // Read only by engines that honour per-tool gating (BYOK). The hosted
    // engines classify by name; both are fed from the same decision.
    needsApproval: options.needsApproval,
    execute: async (input, { abortSignal }) => {
      // BEFORE ANY COMMAND LEAVES THIS PROCESS. Nothing downstream does this:
      // the hosted chat path has no SDK-side validation and Chrome does not
      // check an invocation against the schema it was given, so an argument
      // the model guessed wrong would reach page code as a surprise value and
      // come back as an exception nobody can act on.
      const validation = validateDeclaredArgs(pageTool.inputSchema, input);
      if (!validation.ok) {
        return {
          error:
            `invalid_arguments: ${validation.errors.join(" ")} ` +
            `Re-read the tool's schema and call it again.`,
          pageTool: attributionFor(pageTool, options),
        };
      }
      const result = await options.send(
        {
          kind: "webmcp_invoke",
          // The tool's OWN name. The model-facing `webmcp_` name means nothing
          // to the page.
          toolKey: pageTool.rawName,
          ...(pageTool.frameId ? { frameId: pageTool.frameId } : {}),
          expectedBinding: binding,
          input,
        },
        {
          tabId: options.binding.tabId,
          ...(abortSignal ? { signal: abortSignal } : {}),
        },
      );
      // Attribution rides INSIDE the result, in the half of the output that is
      // ours rather than the page's, so a card reopened tomorrow still knows
      // which tool on which page produced it.
      return { ...result, pageTool: attributionFor(pageTool, options) };
    },
  });
}

function attributionFor(
  pageTool: MintedDeclaredTool,
  options: BuildWebmcpPageToolsOptions,
): PageToolResultAttribution {
  return {
    rawName: pageTool.rawName,
    ...(pageTool.origin !== undefined ? { origin: pageTool.origin } : {}),
    ...(pageTool.frameId !== undefined ? { frameId: pageTool.frameId } : {}),
    navCounter: options.binding.navCounter,
    ...(pageTool.registrationSeq !== undefined
      ? { registrationSeq: pageTool.registrationSeq }
      : {}),
  };
}

/**
 * Is a page tool's declaring origin permitted by this run's allowlist?
 *
 * Same rule as `built-in-tools/browser.ts` applies to a navigation, asked of
 * the tool's own origin: a tool declared by a third-party iframe is code from
 * that iframe's origin, whatever the top-level page happens to be.
 */
function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return true;
  if (!origin) return false;
  return allowlist.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (trimmed === origin) return true;
    try {
      return new URL(origin).hostname === trimmed;
    } catch {
      return false;
    }
  });
}
