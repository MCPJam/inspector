import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";

export const MCP_TASKS_CHECK_CATEGORIES = [
  "dispatch",
  "creation",
  "lifecycle",
] as const;

export type MCPTasksCheckCategory = (typeof MCP_TASKS_CHECK_CATEGORIES)[number];

export const MCP_TASKS_CHECK_IDS = [
  "tasks-wire-resolvable",
  "tasks-declaration-hygiene",
  "tasks-result-type-discipline",
  "tasks-undeclared-capability-rejected",
  "tasks-ttl-shape",
  "tasks-inline-result",
  "tasks-mcp-name-routing",
] as const;

export type MCPTasksCheckId = (typeof MCP_TASKS_CHECK_IDS)[number];

export type MCPTasksCheckStatus = "passed" | "failed" | "skipped";

export interface MCPTasksCheckResult {
  id: MCPTasksCheckId;
  category: MCPTasksCheckCategory;
  title: string;
  description: string;
  status: MCPTasksCheckStatus;
  durationMs: number;
  error?: {
    message: string;
    details?: unknown;
  };
  details?: Record<string, unknown>;
  warnings?: string[];
}

export type MCPTasksConformanceConfig = MCPServerConfig & {
  checkIds?: MCPTasksCheckId[];
  /**
   * Tool used to provoke a task. Optional: without it the runner picks the
   * first tool whose `execution.taskSupport` is `required`, then the first
   * with `optional`, and skips the creation checks when neither exists.
   */
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  /** Upper bound on polling a created task to a terminal status. */
  pollTimeoutMs?: number;
};

export interface NormalizedMCPTasksConformanceConfig {
  serverConfig: MCPServerConfig;
  target: string;
  timeout: number;
  pollTimeoutMs: number;
  checkIds?: MCPTasksCheckId[];
  toolName?: string;
  toolArguments?: Record<string, unknown>;
}

export interface MCPTasksConformanceResult {
  passed: boolean;
  target: string;
  checks: MCPTasksCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPTasksCheckCategory,
    { total: number; passed: number; failed: number; skipped: number }
  >;
  discovery: {
    protocolVersion?: string;
    wire: TasksWire;
    toolCount: number;
    taskCapableToolCount: number;
    probedTool?: string;
    createdTaskId?: string;
  };
}
