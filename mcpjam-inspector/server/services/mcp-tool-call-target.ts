/**
 * Resolution of the `(serverId, toolName)` a proxied `tools/call` executes.
 *
 * Owned here rather than by either caller: `mcp-http-bridge` executes the call
 * and the harness proxy's policy gate decides it, and the two MUST agree — a
 * policy decided on the unresolved name would make a prefixed name a bypass.
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
