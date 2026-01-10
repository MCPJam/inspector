import { Badge } from "@/components/ui/badge";
import { Code2 } from "lucide-react";

interface ToolCall {
  toolName: string;
  arguments: Record<string, any>;
}

interface ToolCallsDisplayProps {
  toolCalls: ToolCall[];
  className?: string;
}

export function ToolCallsDisplay({
  toolCalls,
  className = "",
}: ToolCallsDisplayProps) {
  if (toolCalls.length === 0) {
    return (
      <div className={`text-xs text-muted-foreground ${className}`}>
        No tool calls
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {toolCalls.map((toolCall, idx) => (
        <div
          key={idx}
          className="rounded-md border border-border/40 bg-muted/10 p-2"
        >
          <div className="flex items-center gap-2 mb-1">
            <Code2 className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-xs font-medium">
              {toolCall.toolName}
            </span>
          </div>

          {Object.keys(toolCall.arguments).length > 0 ? (
            <div className="ml-5 space-y-1">
              {Object.entries(toolCall.arguments).map(([key, value]) => (
                <div key={key} className="text-xs">
                  <span className="text-muted-foreground">{key}:</span>{" "}
                  <span className="font-mono">
                    {typeof value === "string"
                      ? `"${value}"`
                      : JSON.stringify(value)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="ml-5 text-xs text-muted-foreground">
              No arguments
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Simple compact version for tables
export function ToolCallsBadges({ toolCalls }: ToolCallsDisplayProps) {
  if (toolCalls.length === 0) {
    return <span className="text-xs text-muted-foreground">None</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {toolCalls.map((toolCall, idx) => (
        <Badge
          key={idx}
          variant="outline"
          className="font-mono text-xs"
          title={JSON.stringify(toolCall.arguments, null, 2)}
        >
          {toolCall.toolName}
        </Badge>
      ))}
    </div>
  );
}
