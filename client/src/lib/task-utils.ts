import { formatDistanceToNow } from "date-fns";
import {
  Wrench,
  MessageSquare,
  FileText,
  type LucideIcon,
} from "lucide-react";
import type { PrimitiveType, StatusHistoryEntry } from "./task-tracker";

/**
 * Configuration for primitive types (tool, prompt, resource)
 */
export const PRIMITIVE_TYPE_CONFIG: Record<
  PrimitiveType,
  { icon: LucideIcon; label: string; color: string }
> = {
  tool: { icon: Wrench, label: "Tool", color: "text-blue-500" },
  prompt: { icon: MessageSquare, label: "Prompt", color: "text-purple-500" },
  resource: { icon: FileText, label: "Resource", color: "text-emerald-500" },
};

/**
 * Format a timestamp as relative time (e.g., "2 minutes ago")
 */
export function formatRelativeTime(isoString: string): string {
  try {
    return formatDistanceToNow(new Date(isoString), { addSuffix: true });
  } catch {
    return isoString;
  }
}

/**
 * Format elapsed time from a start timestamp (e.g., "1m 23s")
 */
export function formatElapsedTime(startTime: string): string {
  try {
    const start = new Date(startTime).getTime();
    const now = Date.now();
    const elapsed = now - start;

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

/**
 * Calculate duration of a status history entry
 */
export function calculateStateDuration(
  statusHistory: StatusHistoryEntry[],
  index: number,
): string {
  const entry = statusHistory[index];
  const nextEntry = statusHistory[index + 1];

  if (!entry) return "—";

  try {
    const start = new Date(entry.timestamp).getTime();
    const end = nextEntry
      ? new Date(nextEntry.timestamp).getTime()
      : Date.now();
    const duration = end - start;

    if (duration < 1000) return "<1s";
    if (duration < 60000) return `${Math.floor(duration / 1000)}s`;
    if (duration < 3600000) {
      const minutes = Math.floor(duration / 60000);
      const seconds = Math.floor((duration % 60000) / 1000);
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    const hours = Math.floor(duration / 3600000);
    const minutes = Math.floor((duration % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  } catch {
    return "—";
  }
}

/**
 * Check if a task status is terminal (completed, failed, or cancelled)
 */
export function isTerminalStatus(
  status: StatusHistoryEntry["status"],
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
