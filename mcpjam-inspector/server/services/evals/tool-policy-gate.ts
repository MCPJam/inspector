import type { ToolSet } from "ai";
import {
  buildToolPolicySnapshot,
  decideToolPolicy,
  type EvalSuiteFileToolPolicy,
  type ToolPolicyDecision,
  type ToolPolicySnapshot,
  type ToolSafetyClassification,
} from "@mcpjam/sdk/contract";

export const TOOL_POLICY_BLOCK_MARKER = "mcpjamPolicyBlock";

export type ToolPolicyBlock = {
  toolName: string;
  reason: ToolPolicyDecision["reason"];
  classification: ToolSafetyClassification;
  at: number;
  toolCallId?: string;
};

export type ToolAnnotationsLookup = Map<
  string,
  Record<string, unknown> | undefined
>;

export type ToolPolicyGate = {
  policy: EvalSuiteFileToolPolicy;
  annotations: ToolAnnotationsLookup;
  blocks: ToolPolicyBlock[];
  warnings: string[];
  recordBlock: (block: Omit<ToolPolicyBlock, "at">) => void;
  blockedToolCallIds: () => ReadonlySet<string>;
  wrap: (tools: ToolSet) => ToolSet;
};

export class UnmatchedToolPolicyNameError extends Error {
  readonly code = "TOOL_POLICY_INVALID";

  constructor(names: string[]) {
    super(
      `TOOL_POLICY_INVALID: Tool policy deny name(s) did not match any available tool: ${names.join(
        ", "
      )}`
    );
    this.name = "UnmatchedToolPolicyNameError";
  }
}

export function toolAnnotationsKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}

/**
 * Resolve the policy for every launch-known tool of every selected server, so
 * the decision can travel to the MCP proxy sealed and be applied there by
 * lookup. Uses the SAME `decideToolPolicy` the in-process gate uses — the proxy
 * never classifies anything, and annotations never leave this process.
 *
 * Requires the annotation lookup D4 already populates before launch
 * (`TOOL_POLICY_ANNOTATIONS_UNAVAILABLE` otherwise), so "known at launch" here
 * is exactly the set the in-process gate would have wrapped.
 */
export function buildHarnessToolPolicySnapshots(args: {
  policy: EvalSuiteFileToolPolicy;
  serverIds: ReadonlyArray<string>;
  annotations: ToolAnnotationsLookup;
}): Record<string, ToolPolicySnapshot> {
  const snapshots: Record<string, ToolPolicySnapshot> = {};
  for (const serverId of args.serverIds) {
    const prefix = toolAnnotationsKey(serverId, "");
    const tools: Array<{
      name: string;
      annotations?: Record<string, unknown>;
    }> = [];
    for (const [key, annotations] of args.annotations) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!name) continue;
      tools.push({ name, ...(annotations ? { annotations } : {}) });
    }
    snapshots[serverId] = buildToolPolicySnapshot({
      policy: args.policy,
      tools,
    });
  }
  return snapshots;
}

export function validateToolPolicyNames(args: {
  policy: EvalSuiteFileToolPolicy;
  availableToolNames: Iterable<string>;
  deferredToolNames?: Iterable<string>;
}): string[] {
  const availableNames = new Set(args.availableToolNames);
  const deferredNames = new Set(args.deferredToolNames ?? []);
  const unmatchedDeny = (args.policy.deny ?? []).filter(
    (name) => !availableNames.has(name)
  );
  const invalidDeny = unmatchedDeny.filter((name) => !deferredNames.has(name));
  if (invalidDeny.length > 0) {
    throw new UnmatchedToolPolicyNameError(invalidDeny);
  }
  const warnings =
    unmatchedDeny.length > invalidDeny.length
      ? [
          `Tool policy deny name(s) could not be resolved at run start: ${unmatchedDeny
            .filter((name) => deferredNames.has(name))
            .join(", ")}`,
        ]
      : [];
  const unmatchedAllow = (args.policy.allow ?? []).filter(
    (name) => !availableNames.has(name)
  );
  if (unmatchedAllow.length > 0) {
    warnings.push(
      `Tool policy allow name(s) did not match any available tool: ${unmatchedAllow.join(
        ", "
      )}`
    );
  }
  return warnings;
}

/**
 * Build the execution-layer policy gate for one iteration.
 *
 * Mode-derived rules apply only to MCP server tools (`_serverId`). MCPJam
 * internal tools (skills, progressive-discovery meta-tools, computer/widget
 * tools, and sandbox `bash`) are not classified by server annotations and are
 * not subject to mode-derived denial. An explicit deny still blocks any tool
 * by name because an operator naming a tool means it.
 *
 * Each driver applies this gate exactly once to its final merged tool map,
 * before applying the eval trace wrapper. A blocked result carries a
 * machine-readable marker, and trace wrappers must recognize that marker and
 * emit no tool span: a policy block is not an MCP call or tool error.
 */
export function createToolPolicyGate(args: {
  policy: EvalSuiteFileToolPolicy;
  annotations: ToolAnnotationsLookup;
  warnings?: ReadonlyArray<string>;
}): ToolPolicyGate {
  const blocks: ToolPolicyBlock[] = [];
  const blockedCallIds = new Set<string>();
  const warnings: string[] = [...(args.warnings ?? [])];
  const recordBlock = (block: Omit<ToolPolicyBlock, "at">): void => {
    blocks.push({ ...block, at: Date.now() });
    if (block.toolCallId) {
      blockedCallIds.add(block.toolCallId);
    }
  };
  return {
    policy: args.policy,
    annotations: args.annotations,
    blocks,
    warnings,
    recordBlock,
    blockedToolCallIds: () => new Set(blockedCallIds),
    wrap(tools) {
      const wrapped: ToolSet = { ...tools };
      for (const [toolName, tool] of Object.entries(tools)) {
        const serverId =
          typeof (tool as { _serverId?: unknown })._serverId === "string"
            ? (tool as unknown as { _serverId: string })._serverId
            : undefined;
        const isExplicitlyDenied =
          args.policy.deny?.includes(toolName) === true;
        if (!serverId && !isExplicitlyDenied) continue;
        const decision = decideToolPolicy({
          toolName,
          annotations: serverId
            ? args.annotations.get(toolAnnotationsKey(serverId, toolName))
            : undefined,
          policy: args.policy,
        });
        if (decision.allowed) continue;
        wrapped[toolName] = {
          ...tool,
          execute: async (
            _input: unknown,
            options?: { toolCallId?: string }
          ) => {
            const block = {
              toolName,
              reason: decision.reason,
              classification: decision.classification,
              ...(options?.toolCallId
                ? { toolCallId: options.toolCallId }
                : {}),
            } satisfies Omit<ToolPolicyBlock, "at">;
            recordBlock(block);
            return {
              content: [
                {
                  type: "text",
                  text: `Call blocked by tool policy: ${decision.reason}`,
                },
              ],
              [TOOL_POLICY_BLOCK_MARKER]: true,
            };
          },
        };
      }
      return wrapped;
    },
  };
}

export function isToolPolicyBlockResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[TOOL_POLICY_BLOCK_MARKER] === true
  );
}
