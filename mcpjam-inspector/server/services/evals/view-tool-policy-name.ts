import type { EvalSuiteFileToolPolicy } from "@mcpjam/sdk/contract";

export const VIEW_TOOL_SERVER_ID = "mcpjam:view";

/** Policy names distinguish view code from an MCP server tool with the same name. */
export function viewToolPolicyName(rawName: string): string {
  return `view:${rawName}`;
}

/** Explicitly qualified allows and denies resolve only after the app renders. */
export function deferredViewToolPolicyNames(policy: EvalSuiteFileToolPolicy): string[] {
  return [...(policy.deny ?? []), ...(policy.allow ?? [])].filter(
    (name) => name.startsWith("view:") && name.length > "view:".length,
  );
}
