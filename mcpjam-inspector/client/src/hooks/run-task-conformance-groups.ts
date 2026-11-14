import {
  planTasksConformance,
  mergeTasksConformanceResults,
  taskGroupFailure,
  MCP_TASKS_TOOL_CHECK_IDS,
  MCP_TASKS_CHECK_IDS,
  type MCPTasksRunOptions,
} from "@mcpjam/sdk/browser";
import type { ConformanceRunBudget } from "@/lib/apis/mcp-conformance-api";
import { runTasksConformance } from "@/lib/apis/mcp-conformance-api";

/** Each group gets its own hosted request budget; stale runs stop scheduling work. */
export async function runTaskConformanceGroups(
  serverName: string,
  options: MCPTasksRunOptions,
  isActive: () => boolean,
  remainingBudget: () => ConformanceRunBudget = () => ({}),
) {
  const started = Date.now();
  if (!isActive()) return undefined;
  const results = [];
  const selected = options.checkIds ?? MCP_TASKS_CHECK_IDS;
  const missing = MCP_TASKS_TOOL_CHECK_IDS.filter(
    (id) =>
      selected.includes(id) &&
      options.checkOverrides?.[id]?.toolName.trim() === "",
  );
  const checkOverrides = { ...options.checkOverrides };
  for (const id of missing) delete checkOverrides[id];
  if (missing.length) {
    const result = taskGroupFailure(
      missing,
      "Select a tool for this check or choose Use suite default, then run again.",
      serverName,
    );
    result.checks = result.checks.map((check) => ({
      ...check,
      details: { missingInput: "tasksProbe" },
    }));
    results.push(result);
  }
  // An unfinished custom selection must not inherit and call the suite tool.
  for (const group of planTasksConformance({
    ...options,
    checkIds: selected.filter(
      (id) => !missing.some((missingId) => missingId === id),
    ),
    checkOverrides,
  })) {
    if (!isActive()) return undefined;
    try {
      results.push(
        (
          await runTasksConformance(serverName, {
            ...group,
            ...remainingBudget(),
          })
        ).result,
      );
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
