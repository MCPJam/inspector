import type { MCPTask, MCPListTasksResult } from "@mcpjam/sdk";
import { authFetch } from "@/lib/session-token";

// Re-export SDK types for convenience
export type Task = MCPTask;
export type ListTasksResult = MCPListTasksResult;

export async function listTasks(
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

export async function getTask(serverId: string, taskId: string): Promise<Task> {
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
    throw new Error(body?.error || `Get task failed (${res.status})`);
  }
  return body as Task;
}

export async function getTaskResult(
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
): Promise<Task> {
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
  return body as Task;
}

// Task capabilities for a server (MCP Tasks spec 2025-11-25)
export interface TaskCapabilities {
  // Server supports task-augmented tools/call requests
  supportsToolCalls: boolean;
  // Server supports tasks/list operation
  supportsList: boolean;
  // Server supports tasks/cancel operation
  supportsCancel: boolean;
}

// Get task capabilities for a server
// Per MCP Tasks spec: clients SHOULD only augment requests with tasks
// if the corresponding capability has been declared by the receiver
export async function getTaskCapabilities(
  serverId: string,
): Promise<TaskCapabilities> {
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
  return body as TaskCapabilities;
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
