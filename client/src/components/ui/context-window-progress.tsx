import React from "react";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { TokenCount, formatTokenCount, getTokenWarningMessage } from "@/lib/token-counter";

interface ContextWindowProgressProps {
  tokenCount: TokenCount;
  className?: string;
  showDetails?: boolean;
  size?: "sm" | "md" | "lg";
}

export function ContextWindowProgress({
  tokenCount,
  className,
  showDetails = true,
  size = "md",
}: ContextWindowProgressProps) {
  const { percentageUsed, warningLevel, totalTokens, contextLimit } = tokenCount;
  const warningMessage = getTokenWarningMessage(tokenCount);

  // Determine colors based on warning level
  const getProgressColor = () => {
    switch (warningLevel) {
      case "danger":
        return "bg-red-500";
      case "warning":
        return "bg-yellow-500";
      default:
        return "bg-green-500";
    }
  };

  const getBadgeVariant = () => {
    switch (warningLevel) {
      case "danger":
        return "destructive";
      case "warning":
        return "secondary";
      default:
        return "outline";
    }
  };

  const getSizeClasses = () => {
    switch (size) {
      case "sm":
        return {
          progress: "h-1",
          text: "text-xs",
          badge: "text-xs px-1.5 py-0.5",
        };
      case "lg":
        return {
          progress: "h-3",
          text: "text-sm",
          badge: "text-sm px-2 py-1",
        };
      default:
        return {
          progress: "h-2",
          text: "text-xs",
          badge: "text-xs px-1.5 py-0.5",
        };
    }
  };

  const sizeClasses = getSizeClasses();

  return (
    <div className={cn("space-y-2", className)}>
      {/* Progress Bar */}
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="space-y-1">
              <Progress
                value={Math.min(percentageUsed, 100)}
                className={cn(
                  "transition-all duration-300",
                  sizeClasses.progress,
                  percentageUsed >= 100 && "animate-pulse"
                )}
                style={{
                  "--progress-bg": warningLevel === "danger" ? "#fef2f2" : 
                                  warningLevel === "warning" ? "#fefce8" : "#f0fdf4",
                } as React.CSSProperties}
              />
              <div
                className={cn(
                  "absolute top-0 left-0 h-full rounded-full transition-all duration-300",
                  getProgressColor(),
                  sizeClasses.progress
                )}
                style={{ width: `${Math.min(percentageUsed, 100)}%` }}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <div className="space-y-1">
              <p className="font-medium">{formatTokenCount(tokenCount)}</p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>System prompt: {tokenCount.systemPromptTokens.toLocaleString()} tokens</p>
                <p>Messages: {tokenCount.messageTokens.toLocaleString()} tokens</p>
                <p>Context limit: {contextLimit.toLocaleString()} tokens</p>
              </div>
              {warningMessage && (
                <p className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1">
                  <AlertTriangle className="size-3" />
                  {warningMessage}
                </p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Details Section */}
      {showDetails && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge 
              variant={getBadgeVariant()} 
              className={cn("font-mono", sizeClasses.badge)}
            >
              {totalTokens.toLocaleString()}/{contextLimit.toLocaleString()}
            </Badge>
            
            {warningLevel !== "safe" && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {warningLevel === "danger" ? (
                  <AlertTriangle className="size-3 text-red-500" />
                ) : (
                  <Info className="size-3 text-yellow-500" />
                )}
              </div>
            )}
          </div>

          <span className={cn("font-mono", sizeClasses.text, "text-muted-foreground")}>
            {percentageUsed.toFixed(1)}%
          </span>
        </div>
      )}

      {/* Warning Message */}
      {warningMessage && showDetails && (
        <div className={cn(
          "flex items-start gap-2 p-2 rounded-md text-xs",
          warningLevel === "danger" 
            ? "bg-red-50 text-red-700 border border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800"
            : "bg-yellow-50 text-yellow-700 border border-yellow-200 dark:bg-yellow-950 dark:text-yellow-300 dark:border-yellow-800"
        )}>
          <AlertTriangle className="size-3 mt-0.5 flex-shrink-0" />
          <span>{warningMessage}</span>
        </div>
      )}
    </div>
  );
}

// Compact version for inline use
export function ContextWindowProgressCompact({
  tokenCount,
  className,
}: Pick<ContextWindowProgressProps, "tokenCount" | "className">) {
  const { percentageUsed, warningLevel } = tokenCount;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex items-center gap-2", className)}>
          <div className="relative">
            <Progress
              value={Math.min(percentageUsed, 100)}
              className="h-1.5 w-12 bg-muted"
            />
            <div
              className={cn(
                "absolute top-0 left-0 h-1.5 rounded-full transition-all duration-300",
                warningLevel === "danger" ? "bg-red-500" :
                warningLevel === "warning" ? "bg-yellow-500" : "bg-green-500"
              )}
              style={{ width: `${Math.min(percentageUsed, 100)}%` }}
            />
          </div>
          <span className={cn(
            "text-xs font-mono",
            warningLevel === "danger" ? "text-red-600 dark:text-red-400" :
            warningLevel === "warning" ? "text-yellow-600 dark:text-yellow-400" :
            "text-muted-foreground"
          )}>
            {percentageUsed.toFixed(0)}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>{formatTokenCount(tokenCount)}</p>
      </TooltipContent>
    </Tooltip>
  );
}