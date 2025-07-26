"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LogEntry } from "@/hooks/use-logger";
import { formatDate } from "@/lib/date-utils";
import { LogLevelBadge } from "./log-level-badge";

interface LogCardProps {
  entry: LogEntry;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export function LogCard({ entry, isExpanded, onToggleExpand }: LogCardProps) {
  const hasExtra = entry.data !== undefined || entry.error !== undefined;

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

              <LogLevelBadge level={entry.level} />

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
              <pre className="text-xs bg-background border rounded p-2 overflow-auto max-h-40">
                {JSON.stringify(entry.data, null, 2)}
              </pre>
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
