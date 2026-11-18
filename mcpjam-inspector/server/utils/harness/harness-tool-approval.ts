import type { HarnessRuntimeAdapter } from "./registry";

export function harnessToolApprovalRefusalReason(args: {
  adapter: HarnessRuntimeAdapter;
  requireToolApproval: boolean;
  mcpClient?: "mcpjam" | "harness";
  /** Whether the host has any selected MCP servers. Selects whether the
   *  MCP-surface arm applies; the native-surface arm applies regardless. */
  hasSelectedMcpServers: boolean;
}): string | undefined {
  if (!args.requireToolApproval) return undefined;
  const name = args.adapter.displayName;
  // A turn nobody can answer pauses too: MCPJam answers each request with a
  // denial (`turnApprovalPolicy`), so every rule below applies to it.
  //
  // The runtime runs its own native tools in-sandbox. If it can't pause on
  // those, approval is unsound for the whole turn — servers or no servers.
  if (!args.adapter.supportsNativeToolApproval) {
    return (
      `The ${name} client does not support interactive tool approval. ` +
      "Turn off tool approvals for this client or choose another client."
    );
  }
  const mcpToolApproval =
    (args.mcpClient ?? args.adapter.mcpDelivery) === "harness"
      ? args.adapter.supportsMcpToolApproval
      : args.adapter.supportsHostExecutedToolApproval;
  if (args.hasSelectedMcpServers && !mcpToolApproval) {
    return (
      `The ${name} client cannot wait for approval of MCP server tools. ` +
      "Turn off tool approvals for this client or choose another client."
    );
  }
  return undefined;
}
