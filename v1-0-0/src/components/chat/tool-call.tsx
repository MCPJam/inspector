"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  XCircle,
  Clock,
  Copy,
  Check,
} from "lucide-react";
import { ToolCall, ToolResult } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import React from "react"; // Added missing import for React

interface ToolCallDisplayProps {
  toolCall: ToolCall;
  toolResult?: ToolResult;
  className?: string;
}

// JSON syntax highlighting component
function JsonDisplay({ data, className }: { data: any; className?: string }) {
  const [copied, setCopied] = useState(false);
  const jsonString = JSON.stringify(data, null, 2);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const formatJson = (str: string) => {
    return str
      .replace(
        /"([^"]+)":/g,
        '<span class="text-blue-600/70 dark:text-blue-400/70">"$1"</span>:',
      )
      .replace(/: "([^"]*)"/g, ': <span class="text-foreground">"$1"</span>')
      .replace(
        /: (true|false)/g,
        ': <span class="text-purple-600/70 dark:text-purple-400/70">$1</span>',
      )
      .replace(
        /: (null)/g,
        ': <span class="text-muted-foreground/60">$1</span>',
      )
      .replace(
        /: (-?\d+(?:\.\d+)?)/g,
        ': <span class="text-orange-600/70 dark:text-orange-400/70">$1</span>',
      );
  };

  return (
    <div className={cn("relative group", className)}>
      <button
        onClick={copyToClipboard}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
        title="Copy JSON"
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-600/70 dark:text-green-400/70" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto p-3 bg-muted/20 rounded-md border">
        <code
          dangerouslySetInnerHTML={{
            __html: formatJson(jsonString),
          }}
        />
      </pre>
    </div>
  );
}

// Collapsible JSON tree view for complex objects
function JsonTree({ data, depth = 0 }: { data: any; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);

  if (typeof data !== "object" || data === null) {
    return (
      <span
        className={cn(
          "text-sm",
          typeof data === "string" && "text-foreground",
          typeof data === "number" &&
            "text-orange-600/70 dark:text-orange-400/70",
          typeof data === "boolean" &&
            "text-purple-600/70 dark:text-purple-400/70",
          data === null && "text-muted-foreground/60",
        )}
      >
        {typeof data === "string" ? `"${data}"` : String(data)}
      </span>
    );
  }

  const isArray = Array.isArray(data);
  const entries = isArray
    ? data.map((item, i) => [i, item])
    : Object.entries(data);
  const bracketOpen = isArray ? "[" : "{";
  const bracketClose = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        {bracketOpen}
        {bracketClose}
      </span>
    );
  }

  return (
    <div className="text-sm">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 hover:bg-muted/50 rounded px-1 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span className="text-muted-foreground">
          {bracketOpen} {!isExpanded && `${entries.length} items`}
        </span>
      </button>
      {isExpanded && (
        <div className="ml-4 border-l border-border pl-2 space-y-1">
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <span className="text-blue-600/70 dark:text-blue-400/70 font-medium min-w-0 flex-shrink-0">
                {isArray ? `[${key}]` : `"${key}"`}:
              </span>
              <div className="min-w-0 flex-1">
                <JsonTree data={value} depth={depth + 1} />
              </div>
            </div>
          ))}
        </div>
      )}
      {isExpanded && (
        <span className="text-muted-foreground ml-4">{bracketClose}</span>
      )}
    </div>
  );
}

// Custom MCP Icon component
const MCPIcon = React.forwardRef<
  React.ElementRef<"svg">,
  React.ComponentProps<"svg">
>(({ className, ...props }, ref) => (
  <svg
    ref={ref}
    fill="currentColor"
    fillRule="evenodd"
    height="1em"
    style={{ flex: "none", lineHeight: 1 }}
    viewBox="0 0 24 24"
    width="1em"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    {...props}
  >
    <title>ModelContextProtocol</title>
    <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
    <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
  </svg>
));
MCPIcon.displayName = "MCPIcon";

export function ToolCallDisplay({
  toolCall,
  toolResult,
  className,
}: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showJsonTree, setShowJsonTree] = useState(false);

  const getStatusIcon = () => {
    switch (toolCall.status) {
      case "completed":
        return (
          <div className="relative">
            <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70" />
            <div className="absolute inset-0 animate-ping">
              <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70 opacity-20" />
            </div>
          </div>
        );
      case "error":
        return (
          <div className="relative">
            <XCircle className="h-4 w-4 text-red-600/70 dark:text-red-400/70" />
            <div className="absolute inset-0 animate-pulse">
              <XCircle className="h-4 w-4 text-red-600/70 dark:text-red-400/70 opacity-30" />
            </div>
          </div>
        );
      case "executing":
        return (
          <div className="relative">
            <Clock className="h-4 w-4 text-blue-600/70 dark:text-blue-400/70 animate-spin" />
            <div className="absolute inset-0 animate-ping">
              <Clock className="h-4 w-4 text-blue-600/70 dark:text-blue-400/70 opacity-20" />
            </div>
          </div>
        );
      default:
        return <Clock className="h-4 w-4 text-muted-foreground/60" />;
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
    <div
      className={cn(
        "border rounded-lg bg-gradient-to-br from-muted/20 to-muted/40 backdrop-blur-sm shadow-sm hover:shadow-md transition-all duration-200",
        toolCall.status === "completed" &&
          "border-green-200/50 dark:border-green-800/50",
        toolCall.status === "error" &&
          "border-red-200/50 dark:border-red-800/50",
        toolCall.status === "executing" &&
          "border-blue-200/50 dark:border-blue-800/50",
        className,
      )}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-all duration-200 rounded-t-lg"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-md bg-background/50 border">
            <MCPIcon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex items-center gap-3">
            <span className="font-semibold text-sm">{toolCall.name}</span>
            {getStatusIcon()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t bg-background/30 backdrop-blur-sm">
          {/* Parameters */}
          {Object.keys(toolCall.parameters).length > 0 && (
            <div className="p-4 border-b border-border/50">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-blue-600/70 dark:bg-blue-400/70"></div>
                  Parameters
                </h4>
                <button
                  onClick={() => setShowJsonTree(!showJsonTree)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded bg-muted/50 hover:bg-muted"
                >
                  {showJsonTree ? "Raw JSON" : "Tree View"}
                </button>
              </div>
              {showJsonTree ? (
                <JsonTree data={toolCall.parameters} />
              ) : (
                <JsonDisplay data={toolCall.parameters} />
              )}
            </div>
          )}

          {/* Result */}
          {toolResult && (
            <div className="p-4">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                <div
                  className={cn(
                    "w-2 h-2 rounded-full",
                    toolResult.error
                      ? "bg-red-600/70 dark:bg-red-400/70"
                      : "bg-green-600/70 dark:bg-green-400/70",
                  )}
                ></div>
                {toolResult.error ? "Error" : "Result"}
              </h4>
              <div>
                {toolResult.error ? (
                  <div className="bg-red-50/30 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/50 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <XCircle className="h-5 w-5 text-red-600/70 dark:text-red-400/70 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium text-foreground mb-1">
                          Tool execution failed
                        </p>
                        <p className="text-muted-foreground text-sm">
                          {toolResult.error}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-green-50/30 dark:bg-green-950/20 border border-green-200/50 dark:border-green-800/50 rounded-lg overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2 bg-green-100/30 dark:bg-green-900/20 border-b border-green-200/50 dark:border-green-800/50">
                      <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70" />
                      <span className="text-sm font-medium text-foreground">
                        Tool executed successfully
                      </span>
                    </div>
                    <div className="p-4">
                      {typeof toolResult.result === "object" ? (
                        <JsonDisplay data={toolResult.result} />
                      ) : (
                        <div className="text-sm text-foreground bg-muted/30 p-3 rounded border">
                          {String(toolResult.result)}
                        </div>
                      )}
                    </div>
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
