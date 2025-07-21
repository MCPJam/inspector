"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Settings,
  CheckCircle,
  XCircle,
  Clock,
} from "lucide-react";
import { ToolCall, ToolResult } from "@/lib/chat-types";
import { cn } from "@/lib/utils";

interface ToolCallDisplayProps {
  toolCall: ToolCall;
  toolResult?: ToolResult;
  className?: string;
}

export function ToolCallDisplay({
  toolCall,
  toolResult,
  className,
}: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const getStatusIcon = () => {
    switch (toolCall.status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "executing":
        return <Clock className="h-4 w-4 text-blue-500 animate-pulse" />;
      default:
        return <Clock className="h-4 w-4 text-gray-400" />;
    }
  };

  const getStatusText = () => {
    switch (toolCall.status) {
      case "completed":
        return "Completed";
      case "error":
        return "Failed";
      case "executing":
        return "Running...";
      default:
        return "Pending";
    }
  };

  return (
    <div className={cn("border rounded-lg bg-muted/30", className)}>
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{toolCall.name}</span>
            {getStatusIcon()}
            <span className="text-xs text-muted-foreground">
              {getStatusText()}
            </span>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t bg-background/50">
          {/* Parameters */}
          {Object.keys(toolCall.parameters).length > 0 && (
            <div className="p-3 border-b">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Parameters
              </h4>
              <div className="space-y-1">
                {Object.entries(toolCall.parameters).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-sm">
                    <span className="font-medium text-muted-foreground min-w-0 flex-shrink-0">
                      {key}:
                    </span>
                    <span className="text-foreground break-all">
                      {typeof value === "object"
                        ? JSON.stringify(value, null, 2)
                        : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result */}
          {toolResult && (
            <div className="p-3">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                {toolResult.error ? "Error" : "Result"}
              </h4>
              <div className="text-sm">
                {toolResult.error ? (
                  <div className="text-red-600 bg-red-50 dark:bg-red-950/20 p-2 rounded border">
                    {toolResult.error}
                  </div>
                ) : (
                  <div className="bg-green-50 dark:bg-green-950/20 p-2 rounded border">
                    <pre className="whitespace-pre-wrap text-xs font-mono">
                      {typeof toolResult.result === "object"
                        ? JSON.stringify(toolResult.result, null, 2)
                        : String(toolResult.result)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
