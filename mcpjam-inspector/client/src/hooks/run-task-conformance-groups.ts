import {
  planTasksConformance,
  mergeTasksConformanceResults,
  taskGroupFailure,
  type MCPTasksRunOptions,
} from "@mcpjam/sdk/browser";
import { runTasksConformance } from "@/lib/apis/mcp-conformance-api";

/** Each group gets its own hosted request budget; stale runs stop scheduling work. */
export async function runTaskConformanceGroups(
  serverName: string,
  options: MCPTasksRunOptions,
  isActive: () => boolean,
) {
  const started = Date.now();
  const results = [];
  for (const group of planTasksConformance(options)) {
    if (!isActive()) return undefined;
    try {
      results.push((await runTasksConformance(serverName, group)).result);
    } catch (error) {
      results.push(
        taskGroupFailure(
          group.checkIds,
          error instanceof Error
            ? error.message
            : "The task checks could not run. Try again.",
          serverName,
          group.toolName,
        ),
      );
    }
    if (!isActive()) return undefined;
  }
  return mergeTasksConformanceResults(
    results,
    options.checkIds,
    Date.now() - started,
  );
}
