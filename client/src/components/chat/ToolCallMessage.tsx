import React, { useState, useMemo } from "react";
import {
  Wrench,
  AlertTriangle,
  Clock,
  CheckCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils/request/utils";

// Tool call message types
export interface ToolCallInfo {
  type: "tool_call" | "tool_error" | "tool_warning" | "tool_result";
  toolName: string;
  args?: string | Record<string, unknown>;
  error?: string;
  message?: string;
  result?: string;
}

// Tool call message component
export const ToolCallMessage: React.FC<{ toolCall: ToolCallInfo }> = ({
  toolCall,
}) => {
  const { type, toolName, args, error, message, result } = toolCall;
  const [isCollapsed, setIsCollapsed] = useState(true);

  // Determine if the result content should be collapsible
  const shouldBeCollapsible = useMemo(() => {
    if (type !== "tool_result" || !result) return false;
    return result.length > 200; // threshold characters
  }, [result, type]);

  const toggleCollapse = () => setIsCollapsed((prev) => !prev);

  const getIcon = () => {
    switch (type) {
      case "tool_call":
        return <Wrench className="w-3 h-3" />;
      case "tool_result":
        return <CheckCircle className="w-3 h-3" />;
      case "tool_error":
        return <AlertTriangle className="w-3 h-3" />;
      case "tool_warning":
        return <Clock className="w-3 h-3" />;
      default:
        return <Wrench className="w-3 h-3" />;
    }
  };

  const getColors = () => {
    switch (type) {
      case "tool_call":
        return "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300";
      case "tool_result":
        return "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300";
      case "tool_error":
        return "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300";
      case "tool_warning":
        return "bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-300";
      default:
        return "bg-gray-50 dark:bg-gray-950/30 border-gray-200 dark:border-gray-800 text-gray-800 dark:text-gray-300";
    }
  };

  const formatArgs = (args: unknown): string => {
    if (typeof args === "string") return args;
    if (args === null || args === undefined) return String(args);
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border p-3 mb-2 text-xs font-mono",
        getColors(),
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        {getIcon()}
        <span className="font-semibold">
          {type === "tool_call" && `Calling ${toolName}`}
          {type === "tool_result" && `${toolName} result`}
          {type === "tool_error" && `${toolName} failed`}
          {type === "tool_warning" && "Warning"}
        </span>
      </div>

      {/* Args */}
      {type === "tool_call" && args && (
        <div className="mt-2">
          <div className="text-xs opacity-75 mb-1">Arguments:</div>
          <pre className="text-xs bg-black/10 dark:bg-white/10 rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {formatArgs(args) as string}
          </pre>
        </div>
      )}

      {/* Error */}
      {type === "tool_error" && error && (
        <div className="mt-2">
          <div className="text-xs opacity-75 mb-1">Error:</div>
          <pre className="text-xs bg-black/10 dark:bg-white/10 rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {error}
          </pre>
        </div>
      )}

      {/* Warning */}
      {type === "tool_warning" && message && (
        <div className="mt-2">
          <div className="text-xs bg-black/10 dark:bg-white/10 rounded p-2">
            {message}
          </div>
        </div>
      )}

      {/* Result */}
      {type === "tool_result" && result && (
        <div className="mt-2 relative">
          <div className="text-xs opacity-75 mb-1">Result:</div>
          <pre className="text-xs bg-black/10 dark:bg-white/10 rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {shouldBeCollapsible && isCollapsed
              ? result.slice(0, 200) + "..."
              : result}
          </pre>

          {/* Centered chevron toggle at bottom */}
          {shouldBeCollapsible && (
            <div className="flex justify-center mt-1">
              <button onClick={toggleCollapse} className="p-1">
                {isCollapsed ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronUp className="w-4 h-4" />
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallMessage;
