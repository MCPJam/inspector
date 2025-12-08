export interface Task {
  taskId: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}

export interface ListTasksResult {
  tasks: Task[];
  nextCursor?: string;
}

export async function listTasks(
  serverId: string,
  cursor?: string,
): Promise<ListTasksResult> {
  const res = await fetch("/api/mcp/tasks/list", {
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
  const res = await fetch("/api/mcp/tasks/get", {
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
  const res = await fetch("/api/mcp/tasks/result", {
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
  const res = await fetch("/api/mcp/tasks/cancel", {
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
