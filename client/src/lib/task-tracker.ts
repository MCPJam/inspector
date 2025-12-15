/**
 * Simple task tracker for MCP Tasks
 *
 * Since FastMCP doesn't persist tasks in tasks/list, we track
 * created tasks locally and poll their status via tasks/get.
 */

import type { Task } from "./apis/mcp-tasks-api";

export type PrimitiveType = "tool" | "prompt" | "resource";

export interface StatusHistoryEntry {
  status: Task["status"];
  timestamp: string;
  statusMessage?: string;
}

export interface TrackedTask {
  taskId: string;
  serverId: string;
  createdAt: string;
  toolName?: string;
  // New fields for visualization
  primitiveType?: PrimitiveType;
  primitiveName?: string;
  statusHistory?: StatusHistoryEntry[];
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

/**
 * Update status history for a task when its status changes
 */
export function updateTaskStatusHistory(
  taskId: string,
  newStatus: Task["status"],
  statusMessage?: string,
): void {
  const tasks = getTrackedTasks();
  const task = tasks.find((t) => t.taskId === taskId);

  if (!task) return;

  // Initialize statusHistory if not present (for backward compatibility)
  if (!task.statusHistory) {
    task.statusHistory = [
      {
        status: "working",
        timestamp: task.createdAt,
      },
    ];
  }

  // Only add if status actually changed
  const lastEntry = task.statusHistory[task.statusHistory.length - 1];
  if (lastEntry?.status !== newStatus) {
    task.statusHistory.push({
      status: newStatus,
      timestamp: new Date().toISOString(),
      statusMessage,
    });

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Get a tracked task by ID
 */
export function getTrackedTaskById(taskId: string): TrackedTask | undefined {
  return getTrackedTasks().find((t) => t.taskId === taskId);
}
