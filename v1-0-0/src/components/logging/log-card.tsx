"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LogEntry, LogLevel } from "@/hooks/use-logger";
import { formatDate } from "@/lib/date-utils";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { useTheme } from "next-themes";

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

interface LogCardProps {
  entry: LogEntry;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export function LogCard({ entry, isExpanded, onToggleExpand }: LogCardProps) {
  const hasExtra = entry.data !== undefined || entry.error !== undefined;
  const { theme } = useTheme();

  return (
    <div className="border rounded-lg font-mono">
      <div
        className={`p-3 cursor-pointer hover:bg-muted/50 ${
          hasExtra ? "" : "cursor-default"
        }`}
        onClick={hasExtra ? onToggleExpand : undefined}
      >
        <div className="flex items-start gap-3">
          {hasExtra && (
            <div className="mt-0.5">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-muted-foreground font-mono text-xs">
                {`[${formatDate(entry.timestamp)}]`}
              </span>

              <Badge
                variant="outline"
                className={`${LOG_LEVEL_COLORS[entry.level]}`}
              >
                {entry.level.toUpperCase()}
              </Badge>

              <Badge variant="secondary">{entry.context}</Badge>

              <span className="flex-1 break-words">{entry.message}</span>
            </div>
          </div>
        </div>
      </div>

      {isExpanded && hasExtra && (
        <div className="border-t bg-muted/20 p-3 space-y-3">
          {entry.data !== undefined && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">
                DATA:
              </div>
              <div className="text-xs bg-background border rounded overflow-auto max-h-60">
                <JsonView
                  src={entry.data as object}
                  dark={theme === "dark"}
                  enableClipboard
                  className="p-2"
                />
              </div>
            </div>
          )}

          {entry.error && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">
                ERROR:
              </div>
              <pre className="text-xs bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded p-2 overflow-auto max-h-40 text-red-700 dark:text-red-400">
                {entry.error.message}
                {entry.error.stack && `\n\n${entry.error.stack}`}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
