export type ToolOrigin = "mcp" | "native" | "builtin" | "unknown";

/** MCP identity takes precedence over runtime or built-in name collisions. */
export function toolOrigin(
  toolName: string,
  tool: { _serverId?: unknown; _toolOrigin?: unknown } = {},
): ToolOrigin {
  if (
    (typeof tool._serverId === "string" && tool._serverId.length > 0) ||
    toolName.startsWith("mcp__")
  )
    return "mcp";
  return tool._toolOrigin === "builtin" || tool._toolOrigin === "native"
    ? tool._toolOrigin
    : "unknown";
}

export function harnessToolOrigin(input: {
  rawToolName: string;
  toolName: string;
  serverId?: string;
  hostTools: Record<string, unknown>;
  nativeTools: readonly { key: string; name?: string; commonName?: string }[];
}): ToolOrigin {
  const { rawToolName, toolName, serverId, hostTools, nativeTools } = input;
  if (serverId || rawToolName.startsWith("mcp__")) return "mcp";
  const hostTool = hostTools[rawToolName];
  if (hostTool && typeof hostTool === "object") {
    const origin = toolOrigin(rawToolName, hostTool);
    if (origin !== "unknown") return origin;
  }
  return nativeTools.some(
    (tool) =>
      tool.key === toolName ||
      tool.name === toolName ||
      tool.commonName === toolName,
  )
    ? "native"
    : "unknown";
}
