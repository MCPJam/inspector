import { useState, useMemo, useRef, useEffect } from "react";
import { Search, ArrowUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useLoggerState, LogLevel, useLogger } from "@/hooks/use-logger";
import { LogCard } from "./logging/log-card";
import { LogLevelBadge } from "./logging/log-level-badge";

const LOG_LEVEL_ORDER = ["error", "warn", "info", "debug", "trace"];

export function TracingTab() {
  const { entries } = useLoggerState();
  const rpcLogger = useLogger("JSON-RPC");
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(
    new Set(),
  );
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [serverFilter, setServerFilter] = useState<string | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showScrollToTop, setShowScrollToTop] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Available serverIds from logs
  const serverIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      const sid = (entry as any)?.data?.serverId;
      if (typeof sid === "string" && sid.length > 0) ids.add(sid);
    }
    return Array.from(ids).sort();
  }, [entries]);

  // Filter entries
  const filteredEntries = useMemo(() => {
    let result =
      levelFilter === "all"
        ? entries
        : entries.filter((entry) => entry.level === levelFilter);

    if (serverFilter !== "all") {
      result = result.filter(
        (entry) => (entry as any)?.data?.serverId === serverFilter,
      );
    }

    if (!searchQuery.trim()) {
      return result;
    }

    const queryLower = searchQuery.toLowerCase();
    return result.filter(
      (entry) =>
        entry.message.toLowerCase().includes(queryLower) ||
        entry.context.toLowerCase().includes(queryLower) ||
        (entry.data &&
          JSON.stringify(entry.data).toLowerCase().includes(queryLower)),
    );
  }, [entries, levelFilter, serverFilter, searchQuery]);

  // Handle scroll events to show/hide scroll to top button
  useEffect(() => {
    const handleScroll = () => {
      if (scrollContainerRef.current) {
        const { scrollTop } = scrollContainerRef.current;
        setShowScrollToTop(scrollTop > 200);
      }
    };

    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", handleScroll);
      return () => scrollContainer.removeEventListener("scroll", handleScroll);
    }
  }, []);

  const scrollToTop = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // Stream JSON-RPC messages from backend and log them
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      const params = new URLSearchParams();
      params.set("replay", "200");
      es = new EventSource(`/api/mcp/servers/rpc/stream?${params.toString()}`);
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data && data.type === "rpc") {
            const serverId: string = data.serverId;
            const direction: string = data.direction;
            const payload: unknown = data.message;
            const ts: string | undefined = data.timestamp;

            const dir =
              typeof direction === "string" ? direction.toUpperCase() : "";
            const msg: any = payload as any;
            const methodName: string =
              typeof msg?.method === "string"
                ? msg.method
                : msg?.result !== undefined
                  ? "result"
                  : msg?.error !== undefined
                    ? "error"
                    : "unknown";
            const summary = `[${serverId}] ${dir} - ${methodName}`;
            rpcLogger.info(summary, {
              serverId,
              direction,
              method: methodName,
              timestamp: ts,
              message: payload,
            });
          }
        } catch {}
      };
      es.onerror = () => {
        try {
          es?.close();
        } catch {}
      };
    } catch {}
    return () => {
      try {
        es?.close();
      } catch {}
    };
  }, [rpcLogger]);

  const toggleExpanded = (index: number) => {
    const newExpanded = new Set(expandedEntries);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedEntries(newExpanded);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Sticky Header Controls */}
      <div className="border-b bg-background p-4 space-y-4 flex-shrink-0 sticky top-0 z-10">
        <h2 className="text-lg font-semibold">Tracing</h2>

        {/* Filters */}
        <div className="flex items-center gap-4">
          <Select
            value={levelFilter}
            onValueChange={(value) => setLevelFilter(value as LogLevel | "all")}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              {LOG_LEVEL_ORDER.map((level) => (
                <SelectItem key={level} value={level}>
                  <LogLevelBadge level={level as LogLevel} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={serverFilter}
            onValueChange={(value) => setServerFilter(value as string | "all")}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="All Servers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Servers</SelectItem>
              {serverIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 flex-1">
            <Search className="h-4 w-4" />
            <Input
              placeholder="Search logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8"
            />
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>Total: {entries.length}</span>
          <span>Filtered: {filteredEntries.length}</span>
        </div>
      </div>

      {/* Log Entries */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-2 font-mono text-sm min-h-0"
      >
        {filteredEntries.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            {entries.length === 0
              ? "No logs yet"
              : "No logs match current filters"}
          </div>
        ) : (
          filteredEntries.map((entry, index) => {
            const isExpanded = expandedEntries.has(index);

            return (
              <LogCard
                key={`${entry.timestamp}-${index}`}
                entry={entry}
                isExpanded={isExpanded}
                onToggleExpand={() => toggleExpanded(index)}
              />
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Floating Scroll to Top Button */}
      {showScrollToTop && (
        <Button
          onClick={scrollToTop}
          size="sm"
          className="fixed bottom-4 right-4 z-20 shadow-lg"
          variant="secondary"
        >
          <ArrowUp className="h-4 w-4 mr-1" />
          Top
        </Button>
      )}
    </div>
  );
}
