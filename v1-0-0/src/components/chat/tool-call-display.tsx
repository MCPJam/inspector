"use client";

import { ToolCall, MCPToolCall } from "@/lib/chat-types";
import { cn } from "@/lib/chat-utils";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";

interface ToolCallDisplayProps {
  toolCall: ToolCall | MCPToolCall;
}

export function ToolCallDisplay({ toolCall }: ToolCallDisplayProps) {
  const isMCPTool = "serverId" in toolCall;

  const getStatusColor = (status: ToolCall["status"]) => {
    switch (status) {
      case "pending":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300";
      case "executing":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300";
      case "completed":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300";
      case "error":
        return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300";
    }
  };

  return (
    <Card className="bg-muted/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            🛠️ {toolCall.name}
            {isMCPTool && (
              <span className="text-xs text-muted-foreground ml-2">
                ({(toolCall as MCPToolCall).serverName})
              </span>
            )}
          </CardTitle>
          <Badge
            variant="secondary"
            className={cn("text-xs", getStatusColor(toolCall.status))}
          >
            {toolCall.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {Object.keys(toolCall.parameters).length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Parameters:
            </div>
            <div className="bg-background rounded-md p-3 text-sm">
              <pre className="whitespace-pre-wrap break-words">
                {JSON.stringify(toolCall.parameters, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {toolCall.status === "executing" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-current rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-current rounded-full animate-bounce delay-100" />
              <div className="w-2 h-2 bg-current rounded-full animate-bounce delay-200" />
            </div>
            Executing...
          </div>
        )}
      </CardContent>
    </Card>
  );
}
