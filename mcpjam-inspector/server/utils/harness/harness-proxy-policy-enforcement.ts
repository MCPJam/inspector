/**
 * Out-of-process `toolPolicy` enforcement for the harness MCP proxy.
 *
 * Pure: given the sealed decision snapshot and a JSON-RPC request, say whether
 * the call is blocked and what the proxy should answer. The route applies this
 * BEFORE `handleJsonRpc`, so a denied call never reaches
 * `MCPClientManager.executeTool`.
 *
 * Three invariants live here, each of which is the obvious wrong fix if moved:
 *  - only `tools/call` is gated. `toolPolicy` names TOOLS; resources and
 *    prompts are out of its scope and are not silently covered.
 *  - `tools/list` is NOT filtered. D4 pinned denied tools as visible-but-blocked
 *    so the model's selection is still observed honestly; hiding them would
 *    corrupt the `selection` stage.
 *  - a block is a SUCCESS envelope carrying a marker, never a JSON-RPC error. A
 *    `-32000` would be recorded as a tool error against the customer's server;
 *    a policy block is `notMeasured` + `blockedByPolicy`, never `failed`.
 */
import {
  decideToolPolicyFromSnapshot,
  type ToolPolicyDecisionReason,
  type ToolPolicySnapshot,
  type ToolSafetyClassification,
} from "@mcpjam/sdk/contract";
import { isHarnessProxyPolicySealAvailable } from "./harness-proxy-policy-seal.js";

/** `_meta` key the harness turn recognises on a tool result to account the
 *  block back onto the iteration (the block happens on whichever replica served
 *  the call; the run streams on its own). */
export const HARNESS_POLICY_BLOCK_META_KEY = "mcpjam/policyBlock";

/**
 * A block accounted back onto the iteration. Structurally the in-process gate's
 * `ToolPolicyBlock` (`server/services/evals/tool-policy-gate.ts`) plus the
 * originating server, so `finalize-iteration` consumes both identically and
 * every downstream surface (stages, decision summary, Check Run annotations)
 * works unchanged.
 */
export interface HarnessPolicyBlockRecord {
  toolName: string;
  reason: ToolPolicyDecisionReason;
  classification: ToolSafetyClassification;
  at: number;
  toolCallId?: string;
  serverId?: string;
}

export interface HarnessPolicyBlockMarker {
  toolName: string;
  reason: ToolPolicyDecisionReason;
  classification: ToolSafetyClassification;
}

/**
 * Resolve the `(serverId, toolName)` a `tools/call` will actually execute.
 *
 * MUST mirror `mcp-http-bridge`'s `tools/call` resolution: it strips a
 * `prefix:tool` form and reroutes to `prefix` when that server exists on the
 * manager. Deciding the policy on the unresolved name would make a prefixed
 * name a bypass.
 */
export function resolveBridgeToolCallTarget(args: {
  serverId: string;
  toolName: string | undefined;
  hasServer: (serverId: string) => boolean;
}): { targetServerId: string; toolName?: string } {
  let targetServerId = args.serverId;
  let toolName = args.toolName;
  if (toolName?.includes(":")) {
    const [prefix, actualName] = toolName.split(":", 2);
    if (actualName) {
      if (prefix && args.hasServer(prefix)) {
        targetServerId = prefix;
      }
      toolName = actualName;
    }
  }
  return { targetServerId, ...(toolName ? { toolName } : {}) };
}

export interface HarnessProxyPolicyBlock {
  marker: HarnessPolicyBlockMarker;
  /** The JSON-RPC response to answer with — a result, never an error. */
  response: {
    jsonrpc: "2.0";
    id: string | number | null;
    result: {
      content: Array<{ type: "text"; text: string }>;
      _meta: Record<string, HarnessPolicyBlockMarker>;
    };
  };
}

/**
 * Decide one JSON-RPC request against the sealed snapshot. Returns `null` when
 * the request is not a policy-gated `tools/call`, or when the call is allowed.
 *
 * `policyServerId` is the server the snapshot was sealed for: a prefixed name
 * that reroutes to a DIFFERENT server is blocked outright, because this
 * envelope carries no decision for that server's tools and permitting it would
 * be the prefix bypass.
 */
export function evaluateHarnessProxyToolPolicy(args: {
  body: { method?: unknown; params?: unknown; id?: unknown };
  policyServerId: string;
  policy: ToolPolicySnapshot;
  hasServer: (serverId: string) => boolean;
}): HarnessProxyPolicyBlock | null {
  const { body, policy, policyServerId } = args;
  if (body.method !== "tools/call") return null;
  const params = (body.params ?? {}) as { name?: unknown };
  const requestedName =
    typeof params.name === "string" ? params.name : undefined;
  const target = resolveBridgeToolCallTarget({
    serverId: policyServerId,
    toolName: requestedName,
    hasServer: args.hasServer,
  });
  // A nameless call is the bridge's own error path; let it produce that error
  // rather than inventing a policy verdict for a call that cannot execute.
  if (!target.toolName) return null;

  const decision =
    target.targetServerId === policyServerId
      ? decideToolPolicyFromSnapshot({
          snapshot: policy,
          toolName: target.toolName,
        })
      : ({
          allowed: false,
          reason: "unknownAtLaunch",
          classification: "unknown",
        } as const);
  if (decision.allowed) return null;

  const marker: HarnessPolicyBlockMarker = {
    toolName: target.toolName,
    reason: decision.reason,
    classification: decision.classification,
  };
  const id =
    typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  return {
    marker,
    response: {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `Call blocked by tool policy: ${decision.reason}`,
          },
        ],
        _meta: { [HARNESS_POLICY_BLOCK_META_KEY]: marker },
      },
    },
  };
}

export const HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON =
  "TOOL_POLICY_UNSUPPORTED: toolPolicy cannot be enforced for harness evals on this deployment because COMPUTERS_TERMINAL_TOKEN_SECRET is absent or too weak to seal the policy into the harness MCP proxy token. Refused rather than run unenforced.";

/**
 * Launch-time refusal for a policied harness run, on DERIVED facts only.
 *
 * The old blanket "harness ⇒ unsupported" is replaced by the one condition a
 * launch site can actually decide: whether this deployment can seal the policy
 * at all. The remaining conditions (a plane whose route accepts an absent
 * token, or an assembled `.mcp.json` entry that ended up with a bare token) are
 * only knowable once the config is built, and are refused there —
 * `buildHarnessProxyMcpJsonFromManager`.
 */
export function harnessToolPolicyLaunchRefusal(args: {
  hasToolPolicy: boolean;
  harness: boolean;
}): string | null {
  if (!args.hasToolPolicy || !args.harness) return null;
  return isHarnessProxyPolicySealAvailable()
    ? null
    : HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON;
}

/** Read the marker off a harness tool result (any nesting the harness reports:
 *  the raw MCP result, or a wrapper carrying it under `result`/`output`). */
export function readHarnessPolicyBlockMarker(
  output: unknown,
  depth = 0
): HarnessPolicyBlockMarker | null {
  if (!output || typeof output !== "object" || depth > 3) return null;
  const direct = (output as { _meta?: unknown })._meta;
  if (direct && typeof direct === "object") {
    const marker = (direct as Record<string, unknown>)[
      HARNESS_POLICY_BLOCK_META_KEY
    ];
    if (marker && typeof marker === "object") {
      const candidate = marker as Partial<HarnessPolicyBlockMarker>;
      if (
        typeof candidate.toolName === "string" &&
        typeof candidate.reason === "string" &&
        typeof candidate.classification === "string"
      ) {
        return candidate as HarnessPolicyBlockMarker;
      }
    }
  }
  for (const key of ["result", "output", "value"] as const) {
    const nested = (output as Record<string, unknown>)[key];
    if (nested && typeof nested === "object") {
      const found = readHarnessPolicyBlockMarker(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
