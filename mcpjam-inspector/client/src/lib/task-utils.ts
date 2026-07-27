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
export interface NormalizedTask {
  wire: TasksWire;
  taskId: string;
  status: Task["status"];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  inputRequests?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function normalizeTask(
  wire: TasksWire,
  raw: Record<string, unknown>,
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

export const STATUS_CONFIG: Record<Task["status"], StatusConfig> = {
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
};

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

export function isTerminalStatus(status: Task["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
