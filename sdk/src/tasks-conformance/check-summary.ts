import {
  MCP_TASKS_CHECK_CATEGORIES,
  type MCPTasksCheckResult,
  type MCPTasksConformanceResult,
} from "./types.js";
import { isUnrunCheck as isUnrun } from "../conformance-outcome.js";
export function summarizeChecks(checks: MCPTasksCheckResult[]) {
  return Object.fromEntries(
    MCP_TASKS_CHECK_CATEGORIES.map((category) => {
      const inCategory = checks.filter((check) => check.category === category);
      return [
        category,
        {
          total: inCategory.length,
          passed: inCategory.filter((c) => c.status === "passed").length,
          failed: inCategory.filter((c) => c.status === "failed").length,
          skipped: inCategory.filter((c) => c.status === "skipped").length,
          couldNotRun: inCategory.filter(isUnrun).length,
        },
      ];
    })
  ) as MCPTasksConformanceResult["categorySummary"];
}
