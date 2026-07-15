import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

/**
 * A tool the case editor can assert on: an MCP-server tool (from
 * `listEvalTools`) or a harness-native "system" tool (Bash, read, …) merged in
 * by {@link mergeSystemToolsIntoAvailableTools}. `source: "system"` marks the
 * latter so pickers that need an MCPJam-invokable tool (pinned tool calls,
 * widget "View (tool)" selects) can exclude them — system tools run inside the
 * harness sandbox and never render widgets or accept pinned invocation.
 */
export type AssertableTool = {
  name: string;
  description?: string;
  inputSchema?: any;
  serverId?: string;
  source?: "system";
};

/**
 * Map a harness's built-in tool catalog into assertable dropdown entries.
 *
 * `name` MUST be the catalog `key`, never the display `name` (nativeName).
 * The Claude Code bridge emits stream tool-call parts through
 * `toCommonName(nativeName)`, which is exactly the `builtinTools` record key
 * (`bash`, `read`, `webSearch`, … for aliased tools; `WebFetch`,
 * `NotebookEdit`, … for native-only ones), and `parseHarnessToolName` passes
 * non-MCP names through untouched — so the key is the name the eval matcher
 * sees in `toolsCalledByPrompt`. An entry minted from the display name
 * ("Bash") would silently never match.
 */
export function systemToolsToAssertable(
  catalog: HarnessBuiltinToolInfo[],
): AssertableTool[] {
  return catalog
    .map((tool) => ({
      name: tool.key,
      description: ["System tool (runs in harness)", tool.description]
        .filter(Boolean)
        .join(" — "),
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      source: "system" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Append the harness system tools to the MCP-server tool list. An MCP tool
 * that happens to share a name with a system tool wins — the matcher compares
 * bare names, so a second entry with the same value would be indistinguishable
 * anyway.
 */
export function mergeSystemToolsIntoAvailableTools(
  availableTools: AssertableTool[],
  catalog: HarnessBuiltinToolInfo[],
): AssertableTool[] {
  if (catalog.length === 0) return availableTools;
  const taken = new Set(availableTools.map((tool) => tool.name));
  const systemTools = systemToolsToAssertable(catalog).filter(
    (tool) => !taken.has(tool.name),
  );
  if (systemTools.length === 0) return availableTools;
  return [...availableTools, ...systemTools];
}
