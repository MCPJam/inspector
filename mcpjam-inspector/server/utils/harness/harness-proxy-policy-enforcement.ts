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
  isToolPolicyDecisionReason,
  type ToolPolicyDecisionReason,
  type ToolPolicySnapshot,
  type ToolSafetyClassification,
} from "@mcpjam/sdk/contract";
import { resolveBridgeToolCallTarget } from "../../services/mcp-tool-call-target.js";
import { isHarnessProxyPolicySealAvailable } from "./harness-proxy-policy-seal.js";
import { getHarnessAdapter, type HarnessId } from "./registry.js";

export { resolveBridgeToolCallTarget };

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
            text: `${HARNESS_POLICY_BLOCK_TEXT_PREFIX}${decision.reason}`,
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
 *
 * DELIVERY-AWARE (COMP-39). The seal only exists to carry a policy OUT of this
 * process, into a sandbox that calls the customer's server itself. That is
 * `mcpDelivery: "native"`. A `host-executed` adapter's MCP calls never leave
 * this process — `projectSelectedMcpServersAsHostTools` gates them in-process
 * with the same `decideToolPolicyFromSnapshot` and the same block envelope — so
 * a deployment with a weak or absent `COMPUTERS_TERMINAL_TOKEN_SECRET` was
 * refusing every policied Codex eval over a token it would never mint.
 *
 * The harness is taken as an ID rather than a boolean precisely so no caller
 * can forget to say which delivery it gets: the adapter is the one source of
 * that answer, and the fail-closed native arm is untouched.
 */
export function harnessToolPolicyLaunchRefusal(args: {
  hasToolPolicy: boolean;
  /** The run's harness, or undefined for the emulated engine. */
  harness: HarnessId | undefined;
}): string | null {
  if (!args.hasToolPolicy || !args.harness) return null;
  if (getHarnessAdapter(args.harness).mcpDelivery !== "native") return null;
  return isHarnessProxyPolicySealAvailable()
    ? null
    : HARNESS_TOOL_POLICY_SEAL_UNAVAILABLE_REASON;
}

/**
 * Leading text of a block's user-visible content. The model reads it, and the
 * harness turn matches on it as the SECONDARY detector — see
 * `readHarnessPolicyBlockFromResult`.
 */
export const HARNESS_POLICY_BLOCK_TEXT_PREFIX = "Call blocked by tool policy: ";

/** Collect the text a harness reports for a tool result, across the shapes the
 *  adapters use: a bare string (Claude Code flattens content blocks), a content
 *  array, or an MCP result object. */
function collectResultText(output: unknown, depth = 0): string[] {
  if (typeof output === "string") return [output];
  if (depth > 3 || !output || typeof output !== "object") return [];
  if (Array.isArray(output)) {
    return output.flatMap((entry) => collectResultText(entry, depth + 1));
  }
  const record = output as Record<string, unknown>;
  const texts: string[] = [];
  for (const key of [
    "text",
    "content",
    "result",
    "output",
    "value",
    "stdout",
  ]) {
    const nested = record[key];
    if (nested !== undefined) {
      texts.push(...collectResultText(nested, depth + 1));
    }
  }
  return texts;
}

/**
 * Recognise a policy block in the result the harness reports back, for the run's
 * OWN sealed snapshot.
 *
 * Two detectors, in order:
 *  1. the structured `_meta` marker, when the harness preserves it;
 *  2. the block's TEXT, because the real Claude Code adapter does not: it
 *     flattens an MCP result's content blocks to a bare string
 *     (`stringifyContent` in `@ai-sdk/harness-claude-code`'s bridge), dropping
 *     `_meta` before `run-harness-turn` ever sees the part. This detector
 *     depends on our own block wording surviving the adapter, so it is a
 *     FALLBACK to the authoritative channel (`harness-policy-block-channel.ts`),
 *     not the mechanism — but it is the only one that is synchronous with the
 *     result, and reporting a blocked call as a successful one is the failure
 *     this lane ranks worst.
 *
 * Neither detector trusts the payload for the VERDICT: the record is always the
 * decision this run's snapshot already made for that tool, so a server echoing
 * the block text cannot invent a block for a tool the policy allows.
 */
export function readHarnessPolicyBlockFromResult(args: {
  output: unknown;
  snapshot: ToolPolicySnapshot;
  toolName: string;
}): HarnessPolicyBlockMarker | null {
  const decision = decideToolPolicyFromSnapshot({
    snapshot: args.snapshot,
    toolName: args.toolName,
  });
  const marker = readHarnessPolicyBlockMarker(args.output);
  const blockedByText = collectResultText(args.output).some((text) => {
    const trimmed = text.trim();
    if (!trimmed.startsWith(HARNESS_POLICY_BLOCK_TEXT_PREFIX)) return false;
    return isToolPolicyDecisionReason(
      trimmed.slice(HARNESS_POLICY_BLOCK_TEXT_PREFIX.length).trim()
    );
  });
  if (!marker && !blockedByText) return null;
  if (decision.allowed) return null;
  return {
    toolName: args.toolName,
    reason: decision.reason,
    classification: decision.classification,
  };
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
