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
import type { Task } from "./apis/mcp-tasks-api";
import type { PrimitiveType } from "./task-tracker";

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
