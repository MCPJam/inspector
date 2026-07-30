import { formatDistanceToNow } from "date-fns";
import {
  Wrench,
  MessageSquare,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle,
  XCircle,
  Slash,
  type LucideIcon,
} from "lucide-react";
import type { Task, TasksWire } from "./apis/mcp-tasks-api";
import type { PrimitiveType } from "./task-tracker";

/**
 * A task rendered by the shared UI. Both wires carry the same information
 * under different field names (`ttl`/`pollInterval` vs `ttlMs`/
 * `pollIntervalMs`), plus extension-only inline `result`/`error`/
 * `inputRequests`. The era-native object stays available as `raw` so the
 * debugger can show wire truth.
 */
/**
 * Synthetic status for a tracked handle the server no longer knows (`-32602`).
 * It is not a wire status: it only ever originates from the local tracker.
 */
export const UNAVAILABLE_STATUS = "unavailable" as const;

export type TaskDisplayStatus = Task["status"] | typeof UNAVAILABLE_STATUS;

export interface NormalizedTask {
  wire: TasksWire;
  taskId: string;
  status: TaskDisplayStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  inputRequests?: Record<string, unknown>;
  /** Local-only: the server answered `-32602` for this handle. */
  expired?: boolean;
  raw: Record<string, unknown>;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function normalizeTask(
  wire: TasksWire,
  raw: Record<string, unknown>
): NormalizedTask {
  const ttl = wire === "extension" ? raw.ttlMs : raw.ttl;
  const pollInterval =
    wire === "extension" ? raw.pollIntervalMs : raw.pollInterval;

  return {
    wire,
    taskId: String(raw.taskId ?? ""),
    status: raw.status as Task["status"],
    statusMessage:
      typeof raw.statusMessage === "string" ? raw.statusMessage : undefined,
    createdAt: String(raw.createdAt ?? ""),
    lastUpdatedAt: String(raw.lastUpdatedAt ?? raw.createdAt ?? ""),
    ttl: typeof ttl === "number" ? ttl : null,
    pollInterval: optionalNumber(pollInterval),
    result: raw.result,
    error: raw.error as NormalizedTask["error"],
    inputRequests: raw.inputRequests as Record<string, unknown> | undefined,
    raw,
  };
}

// Status configuration for task states
export interface StatusConfig {
  icon: LucideIcon;
  color: string;
  bgColor: string;
  animate: boolean;
}

export const STATUS_CONFIG: Record<TaskDisplayStatus, StatusConfig> = {
  working: {
    icon: Loader2,
    color: "text-info",
    bgColor: "bg-info/10",
    animate: true,
  },
  input_required: {
    icon: AlertCircle,
    color: "text-warning",
    bgColor: "bg-warning/10",
    animate: false,
  },
  completed: {
    icon: CheckCircle,
    color: "text-success",
    bgColor: "bg-success/10",
    animate: false,
  },
  failed: {
    icon: XCircle,
    color: "text-destructive",
    bgColor: "bg-destructive/10",
    animate: false,
  },
  cancelled: {
    icon: Slash,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
    animate: false,
  },
  [UNAVAILABLE_STATUS]: {
    icon: Slash,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
    animate: false,
  },
};

/**
 * Renders a tracked handle the server has forgotten straight from tracker
 * state — no network read, since re-polling it can only fail again.
 */
/**
 * A row for a tracked handle we have not read yet in this session.
 *
 * Rendered on the first tick after a reload, when a restored handle's stored
 * poll floor has not yet elapsed. It carries the last status the tracker
 * persisted so the list is not empty — an empty list would make the tab think
 * there are no active tasks, never start auto-refresh, and leave the handle
 * unpolled and invisible until a manual refresh.
 *
 * Deliberately NOT marked `expired`: the server has said nothing about this
 * handle. It is simply not due yet.
 */
export function restoredPlaceholderTask(tracked: {
  taskId: string;
  wire: TasksWire;
  createdAt: string;
  status?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
}): NormalizedTask {
  // Validated, not cast. The tracker is localStorage — hand-editable, and
  // written by every version of this app the browser has ever run — so an
  // unrecognized string reaching `status` unchecked would render as an unknown
  // badge at best. The dangerous direction is a bogus value that reads as
  // TERMINAL: the row would stop being polled and a live task would sit there
  // frozen. `unavailable` is excluded for the same reason from the other side —
  // it is this app's own tombstone for "the server forgot it", a conclusion
  // only `expiredPlaceholderTask` is entitled to draw, never restored state.
  const status: NormalizedTask["status"] =
    tracked.status === "working" ||
    tracked.status === "input_required" ||
    tracked.status === "completed" ||
    tracked.status === "failed" ||
    tracked.status === "cancelled"
      ? tracked.status
      : "working";
  return {
    wire: tracked.wire,
    taskId: tracked.taskId,
    status,
    createdAt: tracked.createdAt,
    lastUpdatedAt: tracked.lastUpdatedAt ?? tracked.createdAt,
    ttl: tracked.ttlMs ?? null,
    ...(tracked.pollIntervalMs !== undefined
      ? { pollInterval: tracked.pollIntervalMs }
      : {}),
    raw: { taskId: tracked.taskId },
  };
}

/**
 * A row for a handle recovered from the hosted registry — the sibling of
 * {@link restoredPlaceholderTask} for entries that were never in this
 * browser's tracker (cleared storage, another device).
 *
 * Renders the registry's `lastKnownStatus` and `createdAt` until the first
 * live read replaces it. The registry's own `expired` status maps onto the
 * local `unavailable` tombstone — the registry recorded that a live read
 * already answered -32602 for this handle, which is the same conclusion
 * `expiredPlaceholderTask` draws locally. Any other unrecognized status
 * falls back to `working` for the same reason as the restored placeholder:
 * a bogus value must not read as terminal and freeze a live task.
 */
export function registryPlaceholderTask(entry: {
  taskId: string;
  wire: TasksWire;
  lastKnownStatus: string;
  /** Epoch milliseconds, as the registry stores it. */
  createdAt: number;
  updatedAt?: number;
}): NormalizedTask {
  if (entry.lastKnownStatus === "expired") {
    return expiredPlaceholderTask({
      taskId: entry.taskId,
      wire: entry.wire,
      createdAt: new Date(entry.createdAt).toISOString(),
    });
  }
  const status: NormalizedTask["status"] =
    entry.lastKnownStatus === "working" ||
    entry.lastKnownStatus === "input_required" ||
    entry.lastKnownStatus === "completed" ||
    entry.lastKnownStatus === "failed" ||
    entry.lastKnownStatus === "cancelled"
      ? entry.lastKnownStatus
      : "working";
  const createdAt = new Date(entry.createdAt).toISOString();
  return {
    wire: entry.wire,
    taskId: entry.taskId,
    status,
    createdAt,
    lastUpdatedAt:
      entry.updatedAt !== undefined
        ? new Date(entry.updatedAt).toISOString()
        : createdAt,
    ttl: null,
    raw: { taskId: entry.taskId },
  };
}

export function expiredPlaceholderTask(tracked: {
  taskId: string;
  wire: TasksWire;
  createdAt: string;
}): NormalizedTask {
  return {
    wire: tracked.wire,
    taskId: tracked.taskId,
    status: UNAVAILABLE_STATUS,
    statusMessage:
      "The server no longer knows this task (expired, purged, or forgotten across sessions).",
    createdAt: tracked.createdAt,
    lastUpdatedAt: tracked.createdAt,
    ttl: null,
    expired: true,
    raw: { taskId: tracked.taskId },
  };
}

// Primitive type configuration
export const PRIMITIVE_TYPE_CONFIG: Record<
  PrimitiveType,
  { icon: LucideIcon; label: string; color: string }
> = {
  tool: { icon: Wrench, label: "Tool", color: "text-info" },
  prompt: { icon: MessageSquare, label: "Prompt", color: "text-primary" },
  resource: { icon: FileText, label: "Resource", color: "text-success" },
};

export function formatRelativeTime(isoString: string): string {
  try {
    return formatDistanceToNow(new Date(isoString), { addSuffix: true });
  } catch {
    return isoString;
  }
}

export function formatElapsedTime(startTime: string): string {
  try {
    const elapsed = Date.now() - new Date(startTime).getTime();
    if (elapsed < 1000) return "<1s";
    if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s`;
    if (elapsed < 3600000) {
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  } catch {
    return "—";
  }
}

export function isTerminalStatus(status: TaskDisplayStatus): boolean {
  // "unavailable" (expired/forgotten placeholder) is terminal for every
  // consumer: it is never re-polled, never counts as active, and offers no
  // cancel affordance.
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === UNAVAILABLE_STATUS
  );
}
