import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";
import type {
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksReadinessWarning,
  MCPTasksUncheckedAdvice,
} from "./types.js";
import type { TaskOperations } from "./task-operations.js";
import type { InputRequiredLeg, RawTaskResponse } from "./evidence.js";
export interface TaskCheckContext {
  operations: TaskOperations;
  wire: TasksWire;
  finalTask?: Record<string, unknown>;
  createdTaskId?: string;
  noTask: (id: MCPTasksCheckId) => MCPTasksCheckResult;
  selected: Set<MCPTasksCheckId>;
  checks: MCPTasksCheckResult[];
  manager: MCPClientManager;
  serverId: string;
  inputRequiredTask?: Record<string, unknown>;
  inputLeg?: InputRequiredLeg;
  received: unknown[];
  sent: unknown[];
  rawCreation?: RawTaskResponse;
  readiness: MCPTasksReadinessWarning[];
  uncheckedAdvice: MCPTasksUncheckedAdvice[];
}
