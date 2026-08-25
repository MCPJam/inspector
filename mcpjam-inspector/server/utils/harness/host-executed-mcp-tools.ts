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
 * emulated engine uses (`getToolsForAiSdk`), not a second hand-rolled
 * converter. Routing them back out through the proxy would add an HTTP hop from
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
    const serverTools = await args.manager.getToolsForAiSdk([serverId]);
    const snapshot = args.toolPolicy?.[serverId];
    for (const [toolName, tool] of Object.entries(serverTools)) {
      // Layered inward-out, and the order is load-bearing: the policy gate must
      // be OUTERMOST so a denied call short-circuits to the block envelope
      // without ever entering the observer (a blocked call reaches no server and
      // so can raise no scope challenge). With neither layer in force the
      // manager's own tool object is passed through by IDENTITY, keeping exactly
      // one execution path for an MCP call.
      let projected: unknown = tool;
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
