import type { MCPClientManager } from "@mcpjam/sdk";

const OPTIONS: Record<string, readonly string[]> = {
  tools: ["listChanged"],
  resources: ["listChanged", "subscribe"],
  prompts: ["listChanged"],
  completions: [],
  experimental: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Enhanced delivery has no live notification channel; raw forwarding is separate. */
export function enhancedServerCapabilityGaps(candidate: {
  manager: Pick<MCPClientManager, "getInitializationInfo" | "getTasksSupport">;
  serverIds: string[];
  ownedTasksAvailable?: boolean;
}): string[] {
  const gaps = new Set<string>();
  for (const id of candidate.serverIds) {
    const capabilities =
      candidate.manager.getInitializationInfo(id)?.serverCapabilities;
    if (!isRecord(capabilities)) {
      gaps.add("server-capabilities-unavailable");
      continue;
    }
    for (const [name, value] of Object.entries(capabilities)) {
      if (name === "extensions" && isRecord(value)) {
        for (const extension of Object.keys(value)) {
          if (
            extension === "io.modelcontextprotocol/tasks" &&
            candidate.ownedTasksAvailable === true &&
            candidate.manager.getTasksSupport(id).wire === "extension"
          )
            continue;
          gaps.add(`server-capability:extensions.${extension}`);
        }
      } else if (Object.hasOwn(OPTIONS, name) && isRecord(value)) {
        for (const [option, enabled] of Object.entries(value)) {
          if (OPTIONS[name].includes(option) && enabled === false) continue;
          gaps.add(`server-capability:${name}.${option}`);
        }
      } else gaps.add(`server-capability:${name}`);
    }
  }
  return [...gaps];
}
