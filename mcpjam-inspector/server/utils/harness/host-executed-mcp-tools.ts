/**
 * Project a host's selected MCP servers into HOST-EXECUTED AI SDK tools, for a
 * harness whose runtime cannot make an MCP tool model-callable itself
 * (`mcpDelivery: "host-executed"` — Codex today).
 *
 * ## Why this exists
 *
 * Codex's only mode the SDK drives (`codex exec --experimental-json`) completes
 * the MCP handshake and answers `tools/list`, but never registers the tools as
 * model-callable functions (openai/codex#19425). Writing `~/.codex/config.toml`
 * `[mcp_servers]` MERGES cleanly with what the bridge sets and is still a
 * silent no-op — the COMP-39 spike proved that end to end. The harness authors
 * hit the same wall for their own host tools and built a CLI relay instead
 * (`@ai-sdk/harness-codex`'s `src/bridge/cli-relay.ts`), which is the mechanism
 * this module feeds: the bridge injects each tool's description into the
 * prompt, the model shells out via `bash node <shim> <toolName> <json>`, and the
 * invocation is relayed back over HTTP to the agent — which runs `execute()`
 * HERE, on MCPJam's server.
 *
 * ## Direct, not through the harness MCP proxy
 *
 * The signed proxy (`routes/web/harness-mcp.ts` / the adapter-http tunnel)
 * exists so code INSIDE THE SANDBOX can reach a server it has no credentials
 * for. A host-executed tool does not run in the sandbox: it runs in this
 * process, where the authorized `MCPClientManager` connection already lives. So
 * these tools call the manager directly — reusing the SAME projection the
 * emulated engine uses (`getToolsForAiSdk`), and under the SAME host-derived
 * options (`mcpToolOptionsFor`, shared with the emulated engine and both eval
 * runners), not a second hand-rolled converter. Routing them back out through
 * the proxy would add an HTTP hop from
 * this server to itself and would have to mint a token for it. Going direct is
 * also strictly safer: no proxy token and no server URL ever enters the
 * sandbox, so a compromised sandbox cannot reach the servers off-turn at all.
 *
 * The one thing the proxy did that we must NOT lose is out-of-process
 * `toolPolicy` enforcement (the sealed token). That moves in-process here —
 * same `decideToolPolicyFromSnapshot`, same block envelope — so a denied call
 * still never reaches the customer's server and still accounts as
 * `blockedByPolicy`, never `failed`.
 *
 * ## Known limitations (stated, not papered over)
 *
 *  - Schemas are enumerated ONCE, at turn start. There is no `tools/list_changed`
 *    subscription: a server that adds or removes a tool mid-turn is not
 *    reflected until the next turn.
 *  - Scope step-up (SEP-2350) IS carried: an `insufficient_scope` challenge
 *    raised by an in-process call is extracted with the same shared helper the
 *    proxy path uses and handed to the turn's existing bridge (see
 *    {@link projectSelectedMcpServersAsHostTools}'s `onScopeStepUpChallenge`).
 *  - The RELAY carries the model-facing projection of a result, not the raw
 *    one: `toModelOutput` is the manager tool's own, so app-tool `_meta` /
 *    `structuredContent` never reaches the model and `modelVisibleMcpToolResults`
 *    still applies (see {@link withModelOutputProjection}). The raw result is
 *    handed back through `onRawResult` so the UI keeps rendering what the server
 *    actually returned.
 *  - Every projected tool's description is injected into the PROMPT by the
 *    bridge, so a server with many tools inflates every turn of the
 *    conversation. There is no cap here — MCPJam has no tool-count budget to
 *    respect, and inventing one would silently hide the user's own servers.
 */
import {
  decideToolPolicyFromSnapshot,
  type ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";
import type { MCPJamHandlerOptions } from "../mcpjam-stream-handler.js";
import { logger } from "../logger.js";
import { harnessServerKeyToName } from "./mcp-config.js";
import {
  HARNESS_POLICY_BLOCK_META_KEY,
  HARNESS_POLICY_BLOCK_TEXT_PREFIX,
  type HarnessPolicyBlockMarker,
} from "./harness-proxy-policy-enforcement.js";
import { selectDeliverableServerIds } from "./plugin-delivery.js";
import {
  mcpToolOptionsFor,
  type McpToolOptionsInput,
} from "../mcp-tool-options.js";
import { scopeStepUpInfoFromToolError } from "../insufficient-scope-step-up.js";
import type { HarnessScopeStepUpEvent } from "./harness-scope-step-up.js";
import type { RuntimePluginVersion } from "../../services/environments/effective-capabilities.js";

/** The harness tool-name prefix. Claude Code's native scheme, reused verbatim so
 *  a Codex run attributes identically to a Claude Code run. */
export function harnessMcpToolName(serverKey: string, toolName: string): string {
  return `mcp__${serverKey}__${toolName}`;
}

export interface HostExecutedMcpProjection {
  /** Name-keyed AI SDK tools to merge into the agent's host-executed `tools`. */
  tools: Record<string, unknown>;
  /** Sanitized server key → serverId, the SAME map shape the `.mcp.json` path
   *  produces, so `parseToolName` attributes a relayed call to its server. */
  keyToServerId: Record<string, string>;
}

/**
 * Enumerate each selected server's tools and project them into namespaced,
 * host-executed AI SDK tools.
 *
 * The per-server `getToolsForAiSdk([id])` call is deliberate: the manager's
 * multi-id form FLATTENS every server into one name-keyed record (last-in
 * wins), which would both lose the server attribution this projection is built
 * on and silently drop a tool whose name another selected server also uses.
 * One call per server, then namespace — the same shape `evals-runner` uses.
 */
export async function projectSelectedMcpServersAsHostTools(args: {
  manager: MCPJamHandlerOptions["mcpClientManager"];
  selectedServerIds: string[];
  /** Plugin origin per server id (INS-7): a plugin-contributed server with no
   *  live connection fails the turn instead of being silently skipped. */
  pluginOrigins?: Record<string, RuntimePluginVersion>;
  /** Per-server resolved `toolPolicy` decisions for this run. A server with a
   *  snapshot gets its calls gated IN-PROCESS before they reach the server. */
  toolPolicy?: Record<string, ToolPolicySnapshot>;
  /**
   * Sink for an actionable SEP-2350 scope challenge raised by one of these
   * calls. Publishes into the turn's EXISTING harness scope step-up bridge —
   * the same one the proxy publishes into on the native path — so a hosted-OAuth
   * server that needs a step-up pauses the turn here exactly as it does there,
   * instead of surfacing to the model as an ordinary tool failure.
   *
   * Omitted (eval/synthetic callers with no writer) ⇒ tools are passed through
   * unwrapped and a challenge stays an ordinary error, which is the pre-existing
   * behaviour for a turn that cannot pause anyway.
   */
  onScopeStepUpChallenge?: (event: HarnessScopeStepUpEvent) => void;
  /**
   * Sink for the RAW MCP result of each call, keyed by the AI SDK `toolCallId`.
   *
   * The relay receives the model-facing projection (see
   * {@link withModelOutputProjection}), and the runtime echoes back only what it
   * was given — so the turn needs this to keep showing the UI, the trace and the
   * transcript what the server actually returned, exactly as the emulated engine
   * does. Omitted ⇒ the raw result is simply not retained.
   */
  onRawResult?: (args: { toolCallId: string; raw: unknown }) => void;
  /**
   * The HOST-DERIVED tool-construction inputs, resolved by the caller.
   *
   * `getToolsForAiSdk` states plainly that it will not read a host config
   * itself, so anything the host decided about how a tool is BUILT has to
   * arrive here. Omitting them (as this function used to) does not fall back to
   * the host's intent — it falls back to the SDK's defaults, which is how a
   * Codex turn came to run `toModelOutput` under a policy the host never chose.
   *
   * Two of the four `getToolsForAiSdk` options are deliberately NOT accepted:
   *
   *  - `needsApproval` — the AI SDK approval flag is read by MCPJam's EMULATED
   *    loop, which never runs on this path. Host-executed approval is enforced
   *    by `HarnessAgent`'s own `toolApproval` map, which `runHarnessTurn`
   *    builds over every key of `hostExecutedTools` (these projections
   *    included) whenever the host requires approval and the adapter advertises
   *    `supportsHostExecutedToolApproval`; unsound combinations are refused
   *    outright by `harnessToolApprovalRefusalReason`, at the route pre-flight
   *    AND at the in-turn backstop. Setting `needsApproval` here would add a
   *    SECOND approval declaration that nothing on this path reads — inert, and
   *    indistinguishable on inspection from enforcement. So the field is
   *    absent by construction rather than dropped by omission, and a future
   *    host-executed adapter that flips `supportsHostExecutedToolApproval` is
   *    already covered by the map, not by this argument.
   *  - `schemas` — no harness surface overrides tool schemas.
   *
   * Built by the shared {@link mcpToolOptionsFor}, so absent-everything yields
   * `undefined` and the enumeration takes the no-options overload: a default
   * harness turn produces exactly the tools it produced before this existed.
   */
  toolOptions?: McpToolOptionsInput;
}): Promise<HostExecutedMcpProjection> {
  const configured = selectDeliverableServerIds({
    selectedServerIds: args.selectedServerIds,
    hasLiveConfig: (id) => Boolean(args.manager.getServerConfig(id)),
    ...(args.pluginOrigins ? { pluginOrigins: args.pluginOrigins } : {}),
    onSkipped: (id) =>
      logger.warn(
        `[harness] selected server has no live config; skipping serverId=${id}`
      ),
  });
  if (configured.length === 0) return { tools: {}, keyToServerId: {} };

  // Same sanitize + dedup + ordering as the `.mcp.json` keys, from the same
  // helper — so the two delivery modes cannot drift into different tool names.
  const keyToServerId = harnessServerKeyToName(
    configured.map((id) => ({ name: id }))
  );
  const serverIdToKey = new Map<string, string>();
  for (const [key, serverId] of Object.entries(keyToServerId)) {
    serverIdToKey.set(serverId, key);
  }

  // Built ONCE for the whole projection: the options are host-level, and the
  // per-server loop below must not be able to hand two servers different ones.
  const toolOptions = args.toolOptions
    ? mcpToolOptionsFor(args.toolOptions)
    : undefined;

  const tools: Record<string, unknown> = {};
  for (const serverId of configured) {
    const key = serverIdToKey.get(serverId);
    // Unreachable: every configured id got a key above. Fail loud rather than
    // ship the server's tools under a name nothing can attribute.
    if (!key) {
      throw new Error(
        `Harness host-executed MCP projection: no name key for serverId=${serverId}`
      );
    }
    // REUSE the manager's own AI SDK conversion (schemas, result shaping,
    // SEP-1865 app-only visibility filtering, `_serverId` tagging) — the same
    // one the emulated engine runs on. A second converter here would be a
    // second place for the two engines to disagree about a tool.
    //
    // …and reuse it under the HOST's options, not the SDK's defaults. The
    // no-options overload is kept for a default turn so those tools stay
    // byte-identical to what this projection produced before.
    const serverTools = toolOptions
      ? await args.manager.getToolsForAiSdk([serverId], toolOptions)
      : await args.manager.getToolsForAiSdk([serverId]);
    const snapshot = args.toolPolicy?.[serverId];
    for (const [toolName, tool] of Object.entries(serverTools)) {
      // Layered inward-out, and the order is load-bearing:
      //  - the MODEL-OUTPUT projection is INNERMOST, so it only ever sees a real
      //    server result. Above the policy gate it would scrub the block
      //    envelope's `_meta` marker and the turn would stop recognising its own
      //    block.
      //  - the policy gate is OUTERMOST, so a denied call short-circuits to that
      //    envelope without entering the observer (a blocked call reaches no
      //    server and so can raise no scope challenge).
      // With no layer in force the manager's own tool object is passed through
      // by IDENTITY, keeping exactly one execution path for an MCP call.
      let projected: unknown = withModelOutputProjection({
        tool,
        ...(args.onRawResult ? { onRawResult: args.onRawResult } : {}),
      });
      if (args.onScopeStepUpChallenge) {
        projected = withScopeStepUpObserver({
          tool: projected,
          serverId,
          toolName,
          onChallenge: args.onScopeStepUpChallenge,
        });
      }
      if (snapshot) {
        projected = withToolPolicyGate({ tool: projected, toolName, snapshot });
      }
      tools[harnessMcpToolName(key, toolName)] = projected;
    }
  }
  return { tools, keyToServerId };
}

/**
 * Relay the MODEL-FACING projection of an MCP result, not the raw one.
 *
 * The manager's AI SDK tool answers TWO shapes on purpose: `execute()` returns
 * the raw `CallToolResult` (which the inspector's own UI renders — MCP App
 * widgets read `_meta` and `structuredContent` off it), while `toModelOutput()`
 * is the model-facing projection — app-tool `_meta`/`structuredContent`
 * scrubbed, and the host's `modelVisibleMcpToolResults` policy applied to
 * images and embedded/linked resources.
 *
 * The AI SDK's own loop calls both. The harness host-tool loop calls NEITHER
 * but `execute()`: `maybeExecuteHostTool` submits that value straight to
 * `control.submitToolResult`, which the bridge JSON-serializes onto the CLI
 * relay's stdout. So without this wrapper a projected app tool would ship its
 * client-only `_meta` and `structuredContent` into the model's context — pure
 * token cost and context leakage, since a harness cannot render a widget at all
 * (`widgetRendered` is refused at eval admission for exactly that reason) — and
 * `modelVisibleMcpToolResults` would be bypassed entirely.
 *
 * The projection is NOT re-implemented here: it is the tool's own
 * `toModelOutput`, so the harness and the emulated engine can never disagree
 * about what a model may see. A tool that has none (or no `execute`) is passed
 * through BY IDENTITY, so the single-execution-path property still holds.
 *
 * `toModelOutput` answers an AI SDK `ToolResultOutput` envelope rather than a
 * `CallToolResult`, so the envelope is unwrapped before it goes on the wire —
 * see {@link unwrapToolResultOutput}. It is also STRIPPED from the returned
 * tool: having already projected, a future harness that learns to call it must
 * not project a second time.
 */
function withModelOutputProjection(args: {
  tool: unknown;
  onRawResult?: (a: { toolCallId: string; raw: unknown }) => void;
}): unknown {
  const tool = args.tool as {
    execute?: (input: unknown, options: unknown) => unknown;
    toModelOutput?: (opts: {
      toolCallId: string;
      input: unknown;
      output: unknown;
      abortSignal?: AbortSignal;
    }) => unknown;
  };
  const originalExecute = tool.execute?.bind(tool);
  const toModelOutput = tool.toModelOutput?.bind(tool);
  if (!originalExecute || !toModelOutput) return args.tool;
  const { toModelOutput: _projected, ...rest } = tool;
  return {
    ...rest,
    execute: async (input: unknown, options: unknown) => {
      const raw = await originalExecute(input, options);
      const callOptions = options as
        | { toolCallId?: unknown; abortSignal?: unknown }
        | undefined;
      const toolCallId =
        typeof callOptions?.toolCallId === "string"
          ? callOptions.toolCallId
          : undefined;
      if (toolCallId) args.onRawResult?.({ toolCallId, raw });
      const modelOutput = await toModelOutput({
        toolCallId: toolCallId ?? "",
        input,
        output: raw,
        // Linked-resource reads happen inside the projection; pass the turn's
        // signal so a cancelled turn stops them promptly.
        ...(callOptions?.abortSignal instanceof AbortSignal
          ? { abortSignal: callOptions.abortSignal }
          : {}),
      });
      return unwrapToolResultOutput(modelOutput, raw);
    },
  };
}

/**
 * Unwrap an AI SDK `ToolResultOutput` back to the value the relay should carry.
 *
 * `json` / `text` / `error-text` are transport envelopes around a value the
 * relay can serialize directly, and unwrapping them keeps the wire shape
 * IDENTICAL to today's raw path (an ordinary MCP result projects to
 * `{type:"json", value: <result>}`), so this change is invisible to a tool with
 * nothing to scrub. `content` is a genuinely different, self-describing shape
 * (the image/resource projection), so it rides as-is rather than being flattened
 * into something the model would have to guess at. Anything unrecognised falls
 * back to the raw result rather than putting an unknown envelope on the wire.
 */
function unwrapToolResultOutput(modelOutput: unknown, raw: unknown): unknown {
  if (!modelOutput || typeof modelOutput !== "object") return raw;
  const envelope = modelOutput as { type?: unknown; value?: unknown };
  if (
    envelope.type === "json" ||
    envelope.type === "text" ||
    envelope.type === "error-text"
  ) {
    return envelope.value;
  }
  return modelOutput;
}

/**
 * Carry an actionable SEP-2350 scope challenge out of an in-process MCP call.
 *
 * The native path gets this for free: the sandbox's call goes through the signed
 * proxy, which extracts the challenge and publishes it under the turn's
 * correlation id. A host-executed call never touches the proxy — it runs right
 * here — so without this wrapper an `insufficient_scope` response degrades into
 * a plain tool error and the user is never offered the step-up.
 *
 * The extraction and the actionability gate are NOT re-implemented: this calls
 * {@link scopeStepUpInfoFromToolError}, the same helper the proxy path calls,
 * so "which challenges are worth surfacing" has exactly one answer.
 *
 * `toolName` is the UN-NAMESPACED name and `toolInput` the raw arguments,
 * because that is the tuple the turn's bridge correlates a challenge against the
 * observed tool call on (serverId + toolName + input). Errors are always
 * rethrown — this observes, it never swallows.
 */
function withScopeStepUpObserver(args: {
  tool: unknown;
  serverId: string;
  toolName: string;
  onChallenge: (event: HarnessScopeStepUpEvent) => void;
}): unknown {
  const tool = args.tool as {
    execute?: (input: unknown, options: unknown) => unknown;
  };
  const originalExecute = tool.execute?.bind(tool);
  if (!originalExecute) return args.tool;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      try {
        return await originalExecute(input, options);
      } catch (error) {
        const toolCallId = (options as { toolCallId?: unknown } | undefined)
          ?.toolCallId;
        const info = scopeStepUpInfoFromToolError({
          error,
          serverId: args.serverId,
          ...(typeof toolCallId === "string" ? { toolCallId } : {}),
        });
        if (info) {
          args.onChallenge({
            ...info,
            toolName: args.toolName,
            toolInput: input,
          });
        }
        throw error;
      }
    },
  };
}

/**
 * In-process replacement for the proxy's sealed-token gate.
 *
 * Returns the SAME envelope `evaluateHarnessProxyToolPolicy` answers with — a
 * successful MCP result carrying the block marker in `_meta` and the block
 * wording in its text — so `readHarnessPolicyBlockFromResult` recognises it
 * through either detector, and a blocked call is accounted `notMeasured` +
 * `blockedByPolicy` rather than as a failure of the customer's tool.
 */
function withToolPolicyGate(args: {
  tool: unknown;
  toolName: string;
  snapshot: ToolPolicySnapshot;
}): unknown {
  const tool = args.tool as {
    execute?: (input: unknown, options: unknown) => unknown;
  };
  const originalExecute = tool.execute?.bind(tool);
  if (!originalExecute) return args.tool;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const decision = decideToolPolicyFromSnapshot({
        snapshot: args.snapshot,
        toolName: args.toolName,
      });
      if (decision.allowed) return originalExecute(input, options);
      const marker: HarnessPolicyBlockMarker = {
        toolName: args.toolName,
        reason: decision.reason,
        classification: decision.classification,
      };
      return {
        content: [
          {
            type: "text",
            text: `${HARNESS_POLICY_BLOCK_TEXT_PREFIX}${decision.reason}`,
          },
        ],
        _meta: { [HARNESS_POLICY_BLOCK_META_KEY]: marker },
      };
    },
  };
}
