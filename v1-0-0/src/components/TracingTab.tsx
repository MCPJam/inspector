"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  Trash2,
  Search,
  Pause,
  Play,
  Filter,
  ArrowDownToLine,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useLoggerState, LogEntry, LogLevel } from "@/hooks/use-logger";

const LOG_LEVEL_COLORS = {
  error:
    "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-800",
  warn: "bg-yellow-500/10 text-yellow-700 border-yellow-200 dark:text-yellow-400 dark:border-yellow-800",
  info: "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-800",
  debug:
    "bg-purple-500/10 text-purple-700 border-purple-200 dark:text-purple-400 dark:border-purple-800",
  trace:
    "bg-gray-500/10 text-gray-700 border-gray-200 dark:text-gray-400 dark:border-gray-800",
};

const LOG_LEVEL_ORDER = ["error", "warn", "info", "debug", "trace"];

export function TracingTab() {
  const { entries, clearBuffer, getFilteredEntries } = useLoggerState();
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(
    new Set(),
  );
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [contextFilter, setContextFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [pausedEntries, setPausedEntries] = useState<LogEntry[]>([]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Get current entries (paused or live)
  const currentEntries = isPaused ? pausedEntries : entries;

  // Pause/Resume functionality
  useEffect(() => {
    if (isPaused && pausedEntries.length === 0) {
      setPausedEntries(entries);
    }
  }, [isPaused, entries, pausedEntries.length]);

  const handlePauseToggle = () => {
    if (isPaused) {
      // Resume - clear paused entries to show live data
      setPausedEntries([]);
    } else {
      // Pause - capture current entries
      setPausedEntries(entries);
    }
    setIsPaused(!isPaused);
  };

  // Filter entries
  const filteredEntries = useMemo(() => {
    let filtered = currentEntries;

    // Filter by level
    if (levelFilter !== "all") {
      filtered = getFilteredEntries(levelFilter);
    }

    // Filter by context
    if (contextFilter.trim()) {
      const contextLower = contextFilter.toLowerCase();
      filtered = filtered.filter((entry) =>
        entry.context.toLowerCase().includes(contextLower),
      );
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const queryLower = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (entry) =>
          entry.message.toLowerCase().includes(queryLower) ||
          entry.context.toLowerCase().includes(queryLower) ||
          (entry.data &&
            JSON.stringify(entry.data).toLowerCase().includes(queryLower)),
      );
    }

    return filtered;
  }, [
    currentEntries,
    levelFilter,
    contextFilter,
    searchQuery,
    getFilteredEntries,
  ]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && !isPaused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length, autoScroll, isPaused]);

  const toggleExpanded = (index: number) => {
    const newExpanded = new Set(expandedEntries);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedEntries(newExpanded);
  };

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  };

  const scrollToBottom = () => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  };

  const hasExpandableContent = (entry: LogEntry) => {
    return entry.data !== undefined || entry.error !== undefined;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header Controls */}
      <div className="border-b p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Application Tracing</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={scrollToBottom}
              className="gap-2"
            >
              <ArrowDownToLine className="h-4 w-4" />
              Bottom
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePauseToggle}
              className="gap-2"
            >
              {isPaused ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              {isPaused ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearBuffer}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4" />
            <Select
              value={levelFilter}
              onValueChange={(value) =>
                setLevelFilter(value as LogLevel | "all")
              }
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                {LOG_LEVEL_ORDER.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-xs">
            <Search className="h-4 w-4" />
            <Input
              placeholder="Filter by context..."
              value={contextFilter}
              onChange={(e) => setContextFilter(e.target.value)}
              className="h-8"
            />
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-xs">
            <Input
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="auto-scroll"
              checked={autoScroll}
              onCheckedChange={setAutoScroll}
              disabled={isPaused}
            />
            <Label htmlFor="auto-scroll" className="text-sm">
              Auto-scroll
            </Label>
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>Total: {currentEntries.length}</span>
          <span>Filtered: {filteredEntries.length}</span>
          {isPaused && <Badge variant="secondary">Paused</Badge>}
        </div>
      </div>

      {/* Log Entries */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto p-4 space-y-2 font-mono text-sm"
      >
        {filteredEntries.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            {currentEntries.length === 0
              ? "No logs yet"
              : "No logs match current filters"}
          </div>
        ) : (
          filteredEntries.map((entry, index) => {
            const isExpanded = expandedEntries.has(index);
            const hasExtra = hasExpandableContent(entry);

            return (
              <div
                key={`${entry.timestamp}-${index}`}
                className="border rounded-lg"
              >
                <div
                  className={`p-3 cursor-pointer hover:bg-muted/50 ${hasExtra ? "" : "cursor-default"}`}
                  onClick={() => hasExtra && toggleExpanded(index)}
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
                        <span className="text-muted-foreground">
                          [{formatTimestamp(entry.timestamp)}]
                        </span>

                        <Badge
                          variant="outline"
                          className={LOG_LEVEL_COLORS[entry.level]}
                        >
                          {entry.level.toUpperCase()}
                        </Badge>

                        <Badge variant="secondary">{entry.context}</Badge>

                        <span className="flex-1 break-words">
                          {entry.message}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Expanded Content */}
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
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
