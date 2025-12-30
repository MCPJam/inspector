import { Progress } from "@/components/ui/progress";
import { ProgressIndeterminate } from "@/components/ui/progress-indeterminate";
import { formatElapsedTime } from "@/lib/task-utils";
import { useTaskProgress } from "@/hooks/use-task-progress";

interface TaskInlineProgressProps {
  serverId: string | undefined;
  showElapsedTime?: boolean;
  startedAt?: string;
}

/**
 * Compact inline progress display for task list items.
 * Shows determinate progress bar when total is known,
 * indeterminate when total is unknown.
 */
export function TaskInlineProgress({
  serverId,
  showElapsedTime = true,
  startedAt,
}: TaskInlineProgressProps) {
  const { progress, total, message } = useTaskProgress(serverId);

  return (
    <div className="mt-2 space-y-1">
      {/* Progress bar: determinate if total is known, indeterminate otherwise */}
      {total ? (
        <Progress value={(progress / total) * 100} className="h-1.5" />
      ) : (
        <ProgressIndeterminate className="h-1.5" />
      )}

      {/* Progress info row */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="truncate max-w-[150px]">
          {message || (total ? `${progress}/${total}` : "Working...")}
        </span>
        {showElapsedTime && startedAt && (
          <span className="font-mono">{formatElapsedTime(startedAt)}</span>
        )}
      </div>
    </div>
  );
}
