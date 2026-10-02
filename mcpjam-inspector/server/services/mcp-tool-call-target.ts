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

/** Reject a qualified tool targeting another configured server. */
export function isCrossServerToolCall(
  manager: { hasServer(id: string): boolean },
  serverId: string,
  body: any,
): boolean {
  const name = body?.method === "tools/call" ? body.params?.name : undefined;
  if (typeof name !== "string" || !name.includes(":")) return false;
  const prefix = name.slice(0, name.indexOf(":"));
  return prefix !== serverId && manager.hasServer(prefix);
}

/** Keep the shared bridge resolver confined even if the server list changes. */
export function pinMcpManagerToServer<
  T extends { hasServer(id: string): boolean },
>(manager: T, serverId: string): T {
  return new Proxy(manager, {
    get(target, key) {
      if (key === "hasServer")
        return (id: string) => id === serverId && target.hasServer(id);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
