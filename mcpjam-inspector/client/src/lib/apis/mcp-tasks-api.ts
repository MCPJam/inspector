import type { MCPListTasksResult, MCPTask } from "@mcpjam/sdk/browser";
import type { RegistryTaskEntry } from "@/shared/hosted-tasks";
import { authFetch } from "@/lib/session-token";
import { ensureLocalMode, runByMode } from "@/lib/apis/mode-client";
import { WebApiError } from "@/lib/apis/web/base";
import {
  cancelHostedTask,
  getHostedTask,
  getHostedTaskCapabilities,
  getHostedTaskResult,
  getHostedTasksBatch,
  listHostedTasks,
  updateHostedTask,
} from "@/lib/apis/web/tasks-api";

// Re-export SDK types for convenience
export type Task = MCPTask;
export type ListTasksResult = MCPListTasksResult;

/** Which tasks wire a connection speaks (see the SDK's tasks-dispatch). */
export type TasksWire = "none" | "legacy" | "extension";

export interface TasksSupport {
  wire: TasksWire;
  toolCalls: boolean;
  list: boolean;
  cancel: boolean;
  update: boolean;
  inlineResult: boolean;
}

export const NO_TASKS_SUPPORT: TasksSupport = {
  wire: "none",
  toolCalls: false,
  list: false,
  cancel: false,
  update: false,
  inlineResult: false,
};

/** Era-native task payload plus the wire it came off. */
export interface TaskEnvelope {
  wire: TasksWire;
  task: Record<string, unknown>;
}

/** The server no longer knows this task (expired/purged/forgotten). */
export class TaskUnknownOrExpiredError extends Error {
  readonly code = "task-unknown-or-expired";
}

/**
 * Hosted task-gone signal. `TASK_NOT_FOUND` is the route's stable code for a
 * server that no longer knows the task; a structureless 404 (no code) means an
 * older replica without the task routes and must NOT be mistaken for it.
 */
function rethrowHostedTaskError(error: unknown): never {
  if (error instanceof WebApiError && error.code === "TASK_NOT_FOUND") {
    throw new TaskUnknownOrExpiredError(error.message);
  }
  throw error;
}

/**
 * `tasks/list` plus, on the hosted path, the best-effort registry recovery
 * attachment. `registryTasks` is ABSENT (not `[]`) when there was no recovery
 * source this tick — local mode always leaves it absent — while `[]` is a
 * verified empty registry.
 */
export interface ListTasksWithRecoveryResult extends MCPListTasksResult {
  registryTasks?: RegistryTaskEntry[];
}

export async function listTasks(
  serverId: string,
  cursor?: string,
): Promise<ListTasksWithRecoveryResult> {
  return runByMode({
    hosted: () =>
      listHostedTasks({
        serverNameOrId: serverId,
        cursor,
      }) as Promise<ListTasksWithRecoveryResult>,
    local: () => listTasksLocal(serverId, cursor),
  });
}

async function listTasksLocal(
  serverId: string,
  cursor?: string,
): Promise<ListTasksResult> {
  const res = await authFetch("/api/mcp/tasks/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, cursor }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `List tasks failed (${res.status})`);
  }
  return body as ListTasksResult;
}

export async function getTask(
  serverId: string,
  taskId: string,
): Promise<TaskEnvelope> {
  return runByMode({
    hosted: async () => {
      try {
        return (await getHostedTask({
          serverNameOrId: serverId,
          taskId,
        })) as TaskEnvelope;
      } catch (error) {
        rethrowHostedTaskError(error);
      }
    },
    local: () => getTaskLocal(serverId, taskId),
  });
}

/** Hosted-only: read every tracked task for one server over one connection. */
export interface TaskBatchEntry {
  taskId: string;
  task?: Record<string, unknown>;
  error?: string;
  code?: string;
}

export async function getTasksBatch(
  serverId: string,
  taskIds: string[],
): Promise<{ wire: TasksWire; tasks: TaskBatchEntry[] }> {
  return getHostedTasksBatch({ serverNameOrId: serverId, taskIds });
}

async function getTaskLocal(
  serverId: string,
  taskId: string,
): Promise<TaskEnvelope> {
  const res = await authFetch("/api/mcp/tasks/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, taskId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    if (body?.code === "task-unknown-or-expired") {
      throw new TaskUnknownOrExpiredError(
        body?.error || "Task is unknown or expired",
      );
    }
    throw new Error(body?.error || `Get task failed (${res.status})`);
  }
  return body as TaskEnvelope;
}

// Extension wire: submit responses to the keyed `inputRequests` snapshot.
export async function updateTask(
  serverId: string,
  taskId: string,
  inputResponses: Record<string, unknown>,
): Promise<TaskEnvelope> {
  return runByMode({
    hosted: async () => {
      try {
        return (await updateHostedTask({
          serverNameOrId: serverId,
          taskId,
          inputResponses,
        })) as TaskEnvelope;
      } catch (error) {
        rethrowHostedTaskError(error);
      }
    },
    local: () => updateTaskLocal(serverId, taskId, inputResponses),
  });
}

async function updateTaskLocal(
  serverId: string,
  taskId: string,
  inputResponses: Record<string, unknown>,
): Promise<TaskEnvelope> {
  const res = await authFetch("/api/mcp/tasks/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, taskId, inputResponses }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    if (body?.code === "task-unknown-or-expired") {
      throw new TaskUnknownOrExpiredError(
        body?.error || "Task is unknown or expired",
      );
    }
    throw new Error(body?.error || `Update task failed (${res.status})`);
  }
  return body as TaskEnvelope;
}

export async function getTaskResult(
  serverId: string,
  taskId: string,
): Promise<unknown> {
  return runByMode({
    hosted: () => getHostedTaskResult({ serverNameOrId: serverId, taskId }),
    local: () => getTaskResultLocal(serverId, taskId),
  });
}

async function getTaskResultLocal(
  serverId: string,
  taskId: string,
): Promise<unknown> {
  const res = await authFetch("/api/mcp/tasks/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, taskId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `Get task result failed (${res.status})`);
  }

  // Per MCP Tasks spec (2025-11-25), tasks/result returns the underlying
  // request's result directly (e.g., CallToolResult for tool calls)
  return body;
}

export async function cancelTask(
  serverId: string,
  taskId: string,
): Promise<{ wire: TasksWire; task: Task | null }> {
  return runByMode({
    hosted: () => cancelHostedTask({ serverNameOrId: serverId, taskId }),
    local: () => cancelTaskLocal(serverId, taskId),
  });
}

async function cancelTaskLocal(
  serverId: string,
  taskId: string,
): Promise<{ wire: TasksWire; task: Task | null }> {
  const res = await authFetch("/api/mcp/tasks/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId, taskId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `Cancel task failed (${res.status})`);
  }
  return body as { wire: TasksWire; task: Task | null };
}

// Get task capabilities for a server
// Per MCP Tasks spec: clients SHOULD only augment requests with tasks
// if the corresponding capability has been declared by the receiver
export async function getTaskCapabilities(
  serverId: string,
): Promise<TasksSupport> {
  return runByMode({
    hosted: () =>
      getHostedTaskCapabilities({
        serverNameOrId: serverId,
      }) as Promise<TasksSupport>,
    local: async () => {
      const res = await authFetch("/api/mcp/tasks/capabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {}

      if (!res.ok) {
        throw new Error(
          body?.error || `Get task capabilities failed (${res.status})`,
        );
      }
      return body as TasksSupport;
    },
  });
}

// Progress notification data
export interface ProgressEvent {
  serverId: string;
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
  timestamp: string;
}

// Get the latest progress for a server
// Hosted connections are ephemeral, so there is no notification stream to
// collect progress from: polling is the spec-guaranteed path and the hosted
// UI hides progress entirely.
export async function getLatestProgress(
  serverId: string,
): Promise<ProgressEvent | null> {
  return runByMode({
    hosted: async () => null,
    local: () => getLatestProgressLocal(serverId),
  });
}

async function getLatestProgressLocal(
  serverId: string,
): Promise<ProgressEvent | null> {
  const res = await authFetch("/api/mcp/tasks/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `Get progress failed (${res.status})`);
  }
  return body.progress as ProgressEvent | null;
}

// Get all active progress for a server
export async function getAllProgress(
  serverId: string,
): Promise<ProgressEvent[]> {
  return runByMode({
    hosted: async () => [],
    local: () => getAllProgressLocal(serverId),
  });
}

async function getAllProgressLocal(
  serverId: string,
): Promise<ProgressEvent[]> {
  const res = await authFetch("/api/mcp/tasks/progress/all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(body?.error || `Get all progress failed (${res.status})`);
  }
  return body.progress as ProgressEvent[];
}

// Elicitation request received via SSE for task-related elicitations
export interface TaskElicitationRequest {
  requestId: string;
  message: string;
  schema: unknown;
  timestamp: string;
  relatedTaskId?: string;
}

// Respond to a task-related elicitation via the global elicitation endpoint
// Per MCP Tasks spec (2025-11-25): elicitations related to tasks include relatedTaskId
export async function respondToTaskElicitation(
  requestId: string,
  action: "accept" | "decline" | "cancel",
  content?: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  ensureLocalMode("Elicitation is not supported in hosted mode");

  const res = await authFetch("/api/mcp/elicitation/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, action, content }),
  });

  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(
      body?.error || `Respond to elicitation failed (${res.status})`,
    );
  }
  return body as { ok: boolean };
}
