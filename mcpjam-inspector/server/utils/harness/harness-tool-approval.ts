import type { HarnessRuntimeAdapter } from "./registry";

export function harnessToolApprovalRefusalReason(args: {
  adapter: HarnessRuntimeAdapter;
  requireToolApproval: boolean;
  mcpClient?: "mcpjam" | "harness";
  /** Whether the host has any selected MCP servers. Selects whether the
   *  MCP-surface arm applies; the native-surface arm applies regardless. */
  hasSelectedMcpServers: boolean;
  /** Nobody can answer an approval on this run (evals, swarms). */
  unattended?: boolean;
}): string | undefined {
  if (!args.requireToolApproval) return undefined;
  const name = args.adapter.displayName;
  if (args.unattended) {
    return (
      `The ${name} client cannot wait for tool approval in evals or swarms. ` +
      "Turn off tool approvals for this client to continue."
    );
  }
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
