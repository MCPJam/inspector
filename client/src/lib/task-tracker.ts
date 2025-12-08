/**
 * Simple task tracker for MCP Tasks
 *
 * Since FastMCP doesn't persist tasks in tasks/list, we track
 * created tasks locally and poll their status via tasks/get.
 */

export interface TrackedTask {
  taskId: string;
  serverId: string;
  createdAt: string;
  toolName?: string;
}

const STORAGE_KEY = "mcp-tracked-tasks";
const MAX_TRACKED_TASKS = 50;

/**
 * Get all tracked tasks from localStorage
 */
export function getTrackedTasks(): TrackedTask[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/**
 * Get tracked tasks for a specific server
 */
export function getTrackedTasksForServer(serverId: string): TrackedTask[] {
  return getTrackedTasks().filter((t) => t.serverId === serverId);
}

/**
 * Add a task to tracking
 */
export function trackTask(task: TrackedTask): void {
  const tasks = getTrackedTasks();

  // Don't add duplicates
  if (tasks.some((t) => t.taskId === task.taskId)) {
    return;
  }

  // Add new task at the beginning
  tasks.unshift(task);

  // Keep only the most recent tasks
  const trimmed = tasks.slice(0, MAX_TRACKED_TASKS);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage might be full or unavailable
  }
}

/**
 * Remove a task from tracking
 */
export function untrackTask(taskId: string): void {
  const tasks = getTrackedTasks().filter((t) => t.taskId !== taskId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Ignore errors
  }
}

/**
 * Clear all tracked tasks for a server
 */
export function clearTrackedTasksForServer(serverId: string): void {
  const tasks = getTrackedTasks().filter((t) => t.serverId !== serverId);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Ignore errors
  }
}

/**
 * Clear all tracked tasks
 */
export function clearAllTrackedTasks(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore errors
  }
}
