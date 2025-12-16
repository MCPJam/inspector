/**
 * Lightweight task tracker for MCP Tasks
 * Tracks task IDs locally since some servers (e.g., FastMCP) don't persist tasks in tasks/list.
 */

export type PrimitiveType = "tool" | "prompt" | "resource";

export interface TrackedTask {
  taskId: string;
  serverId: string;
  createdAt: string;
  toolName?: string;
  primitiveType?: PrimitiveType;
  primitiveName?: string;
  dismissed?: boolean;
}

const STORAGE_KEY = "mcp-tracked-tasks";
const MAX_TRACKED_TASKS = 50;

function loadTasks(): TrackedTask[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveTasks(tasks: TrackedTask[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // localStorage might be full or unavailable
  }
}

export function getTrackedTasks(): TrackedTask[] {
  return loadTasks();
}

export function getTrackedTasksForServer(serverId: string): TrackedTask[] {
  return loadTasks().filter((t) => t.serverId === serverId && !t.dismissed);
}

export function getTrackedTaskById(taskId: string): TrackedTask | undefined {
  return loadTasks().find((t) => t.taskId === taskId);
}

export function trackTask(task: Omit<TrackedTask, "dismissed">): void {
  const tasks = loadTasks();
  if (tasks.some((t) => t.taskId === task.taskId)) return;

  tasks.unshift({ ...task, dismissed: false });
  saveTasks(tasks.slice(0, MAX_TRACKED_TASKS));
}

export function untrackTask(taskId: string): void {
  saveTasks(loadTasks().filter((t) => t.taskId !== taskId));
}

export function dismissTask(taskId: string): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.taskId === taskId);
  if (task) {
    task.dismissed = true;
    saveTasks(tasks);
  }
}

export function dismissTasksForServer(
  serverId: string,
  taskIds: string[],
): void {
  const idsToDissmiss = new Set(taskIds);
  const tasks = loadTasks();
  for (const task of tasks) {
    if (task.serverId === serverId && idsToDissmiss.has(task.taskId)) {
      task.dismissed = true;
    }
  }
  saveTasks(tasks);
}

export function getDismissedTaskIds(serverId: string): Set<string> {
  return new Set(
    loadTasks()
      .filter((t) => t.serverId === serverId && t.dismissed)
      .map((t) => t.taskId),
  );
}

export function clearTrackedTasksForServer(serverId: string): void {
  saveTasks(loadTasks().filter((t) => t.serverId !== serverId));
}

export function clearAllTrackedTasks(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore errors
  }
}
