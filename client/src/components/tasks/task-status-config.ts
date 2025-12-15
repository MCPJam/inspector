import {
  Loader2,
  AlertCircle,
  CheckCircle,
  XCircle,
  Slash,
  type LucideIcon,
} from "lucide-react";
import type { Task } from "@/lib/apis/mcp-tasks-api";

export interface StatusConfig {
  icon: LucideIcon;
  color: string;
  bgColor: string;
  animate: boolean;
}

export const STATUS_CONFIG: Record<Task["status"], StatusConfig> = {
  working: {
    icon: Loader2,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    animate: true,
  },
  input_required: {
    icon: AlertCircle,
    color: "text-yellow-500",
    bgColor: "bg-yellow-500/10",
    animate: false,
  },
  completed: {
    icon: CheckCircle,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    animate: false,
  },
  failed: {
    icon: XCircle,
    color: "text-red-500",
    bgColor: "bg-red-500/10",
    animate: false,
  },
  cancelled: {
    icon: Slash,
    color: "text-gray-500",
    bgColor: "bg-gray-500/10",
    animate: false,
  },
};
