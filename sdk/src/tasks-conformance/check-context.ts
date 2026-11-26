import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";
import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";
import type {
  MCPTasksCheckId,
  MCPTasksCheckResult,
  MCPTasksPassedAdvice,
  MCPTasksReadinessWarning,
  MCPTasksUncheckedAdvice,
} from "./types.js";
import type { TaskOperations } from "./task-operations.js";
import type { InputRequiredLeg, RawTaskResponse } from "./evidence.js";
import type { InputRequiredResultLeg } from "./input-required-result.js";
export interface TaskCheckContext {
  operations: TaskOperations;
  wire: TasksWire;
  inputSnapshots: Record<string, unknown>[];
  repeatedInputKeys?: string[];
  finalTask?: Record<string, unknown>;
  createdTaskId?: string;
  noTask: (id: MCPTasksCheckId) => MCPTasksCheckResult;
  selected: Set<MCPTasksCheckId>;
  checks: MCPTasksCheckResult[];
  manager: MCPClientManager;
  serverId: string;
  inputRequiredTask?: Record<string, unknown>;
  inputLeg?: InputRequiredLeg;
  /** The 2025-11-25 `tasks/result` calls made for a task parked on `input_required`. */
  resultLeg?: InputRequiredResultLeg;
  /** Why polling stopped, when a task read failed after an earlier one worked. */
  pollError?: unknown;
  received: unknown[];
  sent: unknown[];
  rawCreation?: RawTaskResponse;
  readiness: MCPTasksReadinessWarning[];
  uncheckedAdvice: MCPTasksUncheckedAdvice[];
  /** Advice the run checked and the server already meets. */
  passedAdvice: MCPTasksPassedAdvice[];
}
