
import { Badge } from "@/components/ui/badge";
import { LogLevel } from "@/hooks/use-logger";
import { cn } from "@/lib/utils";

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  error:
    "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-800",
  warn: "bg-yellow-500/10 text-yellow-700 border-yellow-200 dark:text-yellow-400 dark:border-yellow-800",
  info: "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-800",
  debug:
    "bg-purple-500/10 text-purple-700 border-purple-200 dark:text-purple-400 dark:border-purple-800",
  trace:
    "bg-gray-500/10 text-gray-700 border-gray-200 dark:text-gray-400 dark:border-gray-800",
};

interface LogLevelBadgeProps {
  level: LogLevel;
}

export function LogLevelBadge({ level }: LogLevelBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn("font-mono", LOG_LEVEL_COLORS[level])}
    >
      {level.toUpperCase()}
    </Badge>
  );
}
