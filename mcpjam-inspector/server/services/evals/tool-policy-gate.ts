import type { ToolSet } from "ai";
import {
  decideToolPolicy,
  type EvalSuiteFileToolPolicy,
  type ToolPolicyDecision,
  type ToolSafetyClassification,
} from "@mcpjam/sdk/contract";

export const TOOL_POLICY_BLOCK_MARKER = "mcpjamPolicyBlock";

export type ToolPolicyBlock = {
  toolName: string;
  reason: ToolPolicyDecision["reason"];
  classification: ToolSafetyClassification;
  at: number;
};

export type ToolAnnotationsLookup = Map<
  string,
  Record<string, unknown> | undefined
>;

export function toolAnnotationsKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
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
 * The gate is intentionally applied before eval trace wrapping. A blocked
 * result carries a machine-readable marker, and trace wrappers must recognize
 * that marker and emit no tool span: a policy block is not an MCP call or
 * tool error.
 */
export function createToolPolicyGate(args: {
  policy: EvalSuiteFileToolPolicy;
  annotations: ToolAnnotationsLookup;
}): {
  blocks: ToolPolicyBlock[];
  wrap: (tools: ToolSet) => ToolSet;
} {
  const blocks: ToolPolicyBlock[] = [];
  return {
    blocks,
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
        if (decision.allowed || typeof tool.execute !== "function") continue;
        wrapped[toolName] = {
          ...tool,
          execute: async () => {
            blocks.push({
              toolName,
              reason: decision.reason,
              classification: decision.classification,
              at: Date.now(),
            });
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
