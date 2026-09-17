import { classifyToolSafety } from "@mcpjam/sdk/contract";
import type { DiscoveryTool } from "./target-discovery";
const CREATE_NAME = /^(create|add|new|insert|register|make)[_-]/i;
const DENIED = new Set(["create_secret", "rotate_secret", "delete_secret"]);
/** Names and server annotations narrow the catalog; they do not prove create-only effects. */
export function computeSetupExcludedToolNames(tools: DiscoveryTool[]) {
  const excluded = new Set<string>();
  const admittedWriteTools: string[] = [];
  const admittedReadTools: string[] = [];
  // Flattened names are ambiguous across servers: deny collisions rather than guessing the source.
  const counts = new Map<string, number>();
  for (const tool of tools)
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  for (const tool of tools) {
    const read = classifyToolSafety(tool.annotations) === "readOnly";
    const write =
      tool.annotations?.readOnlyHint === false &&
      tool.annotations?.destructiveHint === false &&
      CREATE_NAME.test(tool.name);
    if (
      DENIED.has(tool.name.toLowerCase()) ||
      counts.get(tool.name)! > 1 ||
      (!read && !write)
    )
      excluded.add(tool.name);
    else (read ? admittedReadTools : admittedWriteTools).push(tool.name);
  }
  return { excluded: [...excluded], admittedWriteTools, admittedReadTools };
}
