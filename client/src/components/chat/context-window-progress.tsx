import { Progress } from "@/components/ui/progress";
import { ModelDefinition } from "@/shared/types.js";
import {
  getContextUsagePercentage,
  getContextStatus,
  formatTokenCount,
} from "@/lib/token-counter";
import { AlertTriangle, Info } from "lucide-react";

interface ContextWindowProgressProps {
  tokenCount: number;
  model: ModelDefinition | null;
  className?: string;
  showDetails?: boolean;
}

export function ContextWindowProgress({
  tokenCount,
  model,
  className = "",
  showDetails = true,
}: ContextWindowProgressProps) {
  if (!model || !model.contextWindow) {
    return null;
  }

  const percentage = getContextUsagePercentage(tokenCount, model);
  const { status, color } = getContextStatus(percentage);
  const maxTokens = model.contextWindow;

  const getProgressColorClass = () => {
    switch (color) {
      case "green":
        return "bg-green-500";
      case "orange":
        return "bg-orange-500";
      case "red":
        return "bg-red-500";
      default:
        return "bg-blue-500";
    }
  };

  const getStatusIcon = () => {
    if (status === "warning" || status === "danger" || status === "critical") {
      return <AlertTriangle className="h-4 w-4 text-orange-500" />;
    }
    return <Info className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {showDetails && (
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-1">
            {getStatusIcon()}
            <span className="font-medium">Context Window</span>
          </div>
          <div className="text-muted-foreground">
            {formatTokenCount(tokenCount)} / {formatTokenCount(maxTokens)}
            <span className="ml-1">({percentage.toFixed(1)}%)</span>
          </div>
        </div>
      )}

      <div className="relative">
        <Progress value={percentage} className="h-2 bg-muted" />
        <div
          className={`absolute top-0 left-0 h-2 rounded-full transition-all duration-300 ${getProgressColorClass()}`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>

      {status === "critical" && (
        <div className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          Context window nearly full - consider clearing chat history
        </div>
      )}

      {status === "danger" && (
        <div className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          Context window getting full - monitor token usage
        </div>
      )}
    </div>
  );
}
