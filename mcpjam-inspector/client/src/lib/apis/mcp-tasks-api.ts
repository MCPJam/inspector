import type { MCPListTasksResult, MCPTask } from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { ensureLocalMode, runByMode } from "@/lib/apis/mode-client";

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

export async function listTasks(
  serverId: string,
  cursor?: string,
): Promise<ListTasksResult> {
  ensureLocalMode("Tasks are not supported in hosted mode");

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
  ensureLocalMode("Tasks are not supported in hosted mode");

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
  ensureLocalMode("Tasks are not supported in hosted mode");

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
  ensureLocalMode("Tasks are not supported in hosted mode");

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
  ensureLocalMode("Tasks are not supported in hosted mode");

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
    hosted: async () => {
      void serverId;
      return NO_TASKS_SUPPORT;
    },
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
export async function getLatestProgress(
  serverId: string,
): Promise<ProgressEvent | null> {
  ensureLocalMode("Tasks are not supported in hosted mode");

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
  ensureLocalMode("Tasks are not supported in hosted mode");

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
