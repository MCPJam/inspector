/**
 * Lightweight task tracker for MCP Tasks.
 *
 * Tasks are tracked locally because servers are not required to remember them:
 * legacy servers may forget them across sessions, and the extension wire has
 * no `tasks/list` at all — there the tracker IS the list.
 *
 * Identity is the composite `(serverId, wire, taskId)`: task IDs are only
 * unique within a server, and the same ID can exist on both wires while a
 * developer flips protocol versions. Entries are stored under a versioned
 * schema key so old, origin-wide entries can be migrated on load.
 */

import type { TasksWire } from "./apis/mcp-tasks-api";

export type PrimitiveType = "tool" | "prompt" | "resource";

export interface TrackedTask {
  taskId: string;
  serverId: string;
  wire: TasksWire;
  createdAt: string;
  toolName?: string;
  primitiveType?: PrimitiveType;
  primitiveName?: string;
  dismissed?: boolean;
  /** Server no longer knows this task (JSON-RPC -32602 on a read). */
  expired?: boolean;
}

const STORAGE_KEY = "mcp-tracked-tasks";
const SCHEMA_VERSION = 2;
const MAX_TRACKED_TASKS = 50;

interface StoredShape {
  version: number;
  tasks: TrackedTask[];
}

export function taskIdentity(task: {
  serverId: string;
  wire: TasksWire;
  taskId: string;
}): string {
  return `${task.serverId}\u0000${task.wire}\u0000${task.taskId}`;
}

function migrate(parsed: unknown): TrackedTask[] {
  // v1 stored a bare array with no wire tag; those entries predate the
  // extension, so they are legacy by construction.
  if (Array.isArray(parsed)) {
    return parsed.map((task: TrackedTask) => ({ ...task, wire: "legacy" }));
  }
  const stored = parsed as StoredShape | null;
  if (!stored || !Array.isArray(stored.tasks)) return [];
  return stored.tasks
    .filter((task) => task && task.taskId && task.serverId)
    // A stored entry without a wire tag predates the extension; defaulting
    // keeps `wire` non-optional at runtime (identity depends on it).
    .map((task) => (task.wire ? task : { ...task, wire: "legacy" as const }));
}

function loadTasks(): TrackedTask[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    return migrate(JSON.parse(data));
  } catch {
    return [];
  }
}

function saveTasks(tasks: TrackedTask[]): void {
  try {
    const payload: StoredShape = { version: SCHEMA_VERSION, tasks };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage might be full or unavailable
  }
}

export function getTrackedTasks(): TrackedTask[] {
  return loadTasks();
}

export function getTrackedTasksForServer(
  serverId: string,
  wire?: TasksWire,
): TrackedTask[] {
  return loadTasks().filter(
    (t) =>
      t.serverId === serverId &&
      !t.dismissed &&
      (wire === undefined || t.wire === wire),
  );
}

export function getTrackedTaskById(
  taskId: string,
  serverId?: string,
): TrackedTask | undefined {
  return loadTasks().find(
    (t) =>
      t.taskId === taskId && (serverId === undefined || t.serverId === serverId),
  );
}

export function trackTask(task: Omit<TrackedTask, "dismissed">): void {
  const tasks = loadTasks();
  const identity = taskIdentity(task);
  if (tasks.some((t) => taskIdentity(t) === identity)) return;

  tasks.unshift({ ...task, dismissed: false });
  saveTasks(tasks.slice(0, MAX_TRACKED_TASKS));
}

export function untrackTask(taskId: string, serverId?: string): void {
  saveTasks(
    loadTasks().filter(
      (t) =>
        !(
          t.taskId === taskId &&
          (serverId === undefined || t.serverId === serverId)
        ),
    ),
  );
}

export function markTaskExpired(taskId: string, serverId?: string): void {
  const tasks = loadTasks();
  for (const task of tasks) {
    if (
      task.taskId === taskId &&
      (serverId === undefined || task.serverId === serverId)
    ) {
      task.expired = true;
    }
  }
  saveTasks(tasks);
}

export function dismissTask(taskId: string, serverId?: string): void {
  const tasks = loadTasks();
  for (const task of tasks) {
    if (
      task.taskId === taskId &&
      (serverId === undefined || task.serverId === serverId)
    ) {
      task.dismissed = true;
    }
  }
  saveTasks(tasks);
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
