import { Badge } from "@/components/ui/badge";
import { LogLevel } from "@/hooks/use-logger";
import { cn } from "@/lib/utils";

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  error: "bg-destructive/10 text-destructive border-destructive/20",
  warn: "bg-warning/10 text-warning-foreground border-warning/20",
  info: "bg-info/10 text-info border-info/20",
  debug: "bg-secondary text-secondary-foreground border-border",
  trace: "bg-muted text-muted-foreground border-border",
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
