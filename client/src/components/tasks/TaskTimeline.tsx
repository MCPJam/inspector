import { cn } from "@/lib/utils";
import { STATUS_CONFIG } from "./task-status-config";
import {
  formatRelativeTime,
  calculateStateDuration,
} from "@/lib/task-utils";
import type { StatusHistoryEntry } from "@/lib/task-tracker";
import { PlayCircle } from "lucide-react";

interface TaskTimelineProps {
  statusHistory: StatusHistoryEntry[];
  className?: string;
}

/**
 * Visual timeline showing task status transitions.
 * Displays each state with duration and timestamp.
 */
export function TaskTimeline({ statusHistory, className }: TaskTimelineProps) {
  if (!statusHistory || statusHistory.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic py-2">
        No status history available
      </div>
    );
  }

  return (
    <div className={cn("space-y-0", className)}>
      {statusHistory.map((entry, index) => {
        const config = STATUS_CONFIG[entry.status];
        const isLast = index === statusHistory.length - 1;
        // Use PlayCircle for historical "working" entries instead of spinner
        const Icon =
          entry.status === "working" && !isLast ? PlayCircle : config.icon;
        const duration = calculateStateDuration(statusHistory, index);

        return (
          <div key={index} className="flex gap-3">
            {/* Timeline connector */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0",
                  config.bgColor,
                )}
              >
                <Icon
                  className={cn(
                    "h-3 w-3",
                    config.color,
                    // Only animate the current (last) status, not historical entries
                    isLast && config.animate && "animate-spin",
                  )}
                />
              </div>
              {!isLast && (
                <div className="w-0.5 flex-1 min-h-[16px] bg-border" />
              )}
            </div>

            {/* Content */}
            <div className="pb-3 flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "text-xs font-medium capitalize",
                    config.color,
                  )}
                >
                  {entry.status.replace("_", " ")}
                </span>
                <span className="text-[10px] text-muted-foreground font-mono flex-shrink-0">
                  {duration}
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                {formatRelativeTime(entry.timestamp)}
              </div>
              {entry.statusMessage && (
                <p className="text-[10px] text-muted-foreground/80 mt-0.5 line-clamp-2">
                  {entry.statusMessage}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
