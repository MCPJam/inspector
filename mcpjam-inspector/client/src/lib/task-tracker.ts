/**
 * Lightweight task tracker for MCP Tasks.
 *
 * Tasks are tracked locally because servers are not required to remember them:
 * legacy servers may forget them across sessions, and the extension wire has
 * no `tasks/list` at all — there the tracker IS the list.
 *
 * Identity is the composite `(scope, serverId, wire, taskId)`: task IDs are
 * only unique within a server, the same ID can exist on both wires while a
 * developer flips protocol versions, and hosted task IDs are bearer-ish
 * handles that must not leak between accounts or organizations sharing a
 * browser — hence the auth/org `scope` segment. Entries are stored under a
 * versioned schema key so old, origin-wide entries can be migrated on load.
 */

import { TRACKED_TASK_MAX_AGE_MS } from "@/shared/hosted-tasks";
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
  /**
   * Auth/org context the handle was created under (hosted projectId).
   * Undefined for purely local entries, which have no cross-account risk.
   */
  scope?: string;
}

/**
 * Current auth/org context. Set from the API context so a logout or an
 * organization switch immediately hides — and on the next write drops —
 * handles belonging to the previous actor.
 */
let activeScope: string | undefined;

export function setTrackedTaskScope(scope: string | null | undefined): void {
  activeScope = scope ?? undefined;
}

export function getTrackedTaskScope(): string | undefined {
  return activeScope;
}

function inScope(task: TrackedTask): boolean {
  return (task.scope ?? undefined) === activeScope;
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
  scope?: string;
}): string {
  return [task.scope ?? "", task.serverId, task.wire, task.taskId].join("\u0000");
}

function isFresh(task: TrackedTask, now: number): boolean {
  const createdAt = Date.parse(task.createdAt);
  // An unparseable timestamp is kept: dropping a handle we can't date would
  // silently lose a task the user may still be waiting on.
  if (Number.isNaN(createdAt)) return true;
  return now - createdAt < TRACKED_TASK_MAX_AGE_MS;
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

/** Every entry on disk, regardless of scope — writes must not drop other actors' handles. */
function loadAllTasks(): TrackedTask[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return [];
    const now = Date.now();
    return migrate(JSON.parse(data)).filter((task) => isFresh(task, now));
  } catch {
    return [];
  }
}

function loadTasks(): TrackedTask[] {
  return loadAllTasks().filter(inScope);
}

/** Persists the in-scope entries while preserving other actors' entries. */
function saveInScope(next: TrackedTask[]): void {
  saveTasks([...loadAllTasks().filter((t) => !inScope(t)), ...next]);
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
  const scoped = { ...task, scope: task.scope ?? activeScope };
  const tasks = loadTasks();
  const identity = taskIdentity(scoped);
  if (tasks.some((t) => taskIdentity(t) === identity)) return;

  tasks.unshift({ ...scoped, dismissed: false });
  saveInScope(tasks.slice(0, MAX_TRACKED_TASKS));
}

export function untrackTask(taskId: string, serverId?: string): void {
  saveInScope(
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
  saveInScope(tasks);
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
  saveInScope(tasks);
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
  saveInScope(tasks);
}

export function getDismissedTaskIds(serverId: string): Set<string> {
  return new Set(
    loadTasks()
      .filter((t) => t.serverId === serverId && t.dismissed)
      .map((t) => t.taskId),
  );
}

export function clearTrackedTasksForServer(serverId: string): void {
  saveInScope(loadTasks().filter((t) => t.serverId !== serverId));
}

/**
 * Drops every handle for the previous actor. Called on logout / organization
 * switch: task IDs are bearer-ish and must not survive an actor change on a
 * shared browser.
 */
export function clearTrackedTasksForScope(
  scope: string | null | undefined,
): void {
  const target = scope ?? undefined;
  saveTasks(loadAllTasks().filter((t) => (t.scope ?? undefined) !== target));
}

export function clearAllTrackedTasks(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore errors
  }
}
