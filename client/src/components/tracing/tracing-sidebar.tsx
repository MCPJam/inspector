import { useState, useMemo, useRef, useEffect } from "react";
import { Search, Filter, CheckCircle, XCircle, Hammer, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TraceEventDisplay } from "./trace-event";
import { motion, AnimatePresence } from "framer-motion";

interface TraceEvent {
  id: string;
  step: number;
  text?: string;
  toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
  toolResults?: Array<{ result: unknown; error?: string }>;
  timestamp: string;
}

interface TracingSidebarProps {
  traceEvents: TraceEvent[];
  isVisible?: boolean;
  onToggleVisibility?: () => void;
}

type FilterType = "all" | "tool-calls" | "text" | "errors" | "completed";

export function TracingSidebar({ 
  traceEvents, 
  isVisible = true, 
  onToggleVisibility 
}: TracingSidebarProps) {
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (bottomRef.current && traceEvents.length > 0) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [traceEvents.length]);

  // Filter events based on type and search query
  const filteredEvents = useMemo(() => {
    let filtered = traceEvents;

    // Apply type filter
    switch (filterType) {
      case "tool-calls":
        filtered = filtered.filter(event => 
          event.toolCalls && event.toolCalls.length > 0
        );
        break;
      case "text":
        filtered = filtered.filter(event => 
          event.text && event.text.trim()
        );
        break;
      case "errors":
        filtered = filtered.filter(event => 
          event.toolResults?.some(result => result.error)
        );
        break;
      case "completed":
        filtered = filtered.filter(event => 
          event.toolResults && event.toolResults.length > 0 && 
          !event.toolResults.some(result => result.error)
        );
        break;
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const queryLower = searchQuery.toLowerCase();
      filtered = filtered.filter(event => {
        const textMatch = event.text?.toLowerCase().includes(queryLower);
        const toolCallMatch = event.toolCalls?.some(call => 
          call.name.toLowerCase().includes(queryLower) ||
          JSON.stringify(call.params).toLowerCase().includes(queryLower)
        );
        const resultMatch = event.toolResults?.some(result =>
          JSON.stringify(result.result).toLowerCase().includes(queryLower) ||
          result.error?.toLowerCase().includes(queryLower)
        );
        return textMatch || toolCallMatch || resultMatch;
      });
    }

    return filtered;
  }, [traceEvents, filterType, searchQuery]);

  const toggleEventExpanded = (eventId: string) => {
    const newExpanded = new Set(expandedEvents);
    if (newExpanded.has(eventId)) {
      newExpanded.delete(eventId);
    } else {
      newExpanded.add(eventId);
    }
    setExpandedEvents(newExpanded);
  };

  const expandAll = () => {
    setExpandedEvents(new Set(filteredEvents.map(e => e.id)));
  };

  const collapseAll = () => {
    setExpandedEvents(new Set());
  };

  // Calculate stats
  const stats = useMemo(() => {
    const total = traceEvents.length;
    const withToolCalls = traceEvents.filter(e => e.toolCalls && e.toolCalls.length > 0).length;
    const withErrors = traceEvents.filter(e => 
      e.toolResults?.some(result => result.error)
    ).length;
    const completed = traceEvents.filter(e => 
      e.toolResults && e.toolResults.length > 0 && 
      !e.toolResults.some(result => result.error)
    ).length;
    
    return { total, withToolCalls, withErrors, completed };
  }, [traceEvents]);

  if (!isVisible) {
    return (
      <div className="flex items-center justify-center p-4 border-l">
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={onToggleVisibility}
          className="flex items-center gap-2"
        >
          <Eye className="h-4 w-4" />
          Show Traces
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border-l bg-background">
      {/* Header */}
      <div className="flex-shrink-0 p-3 border-b space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Traces</h3>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={onToggleVisibility}
            className="h-6 w-6 p-0"
          >
            <EyeOff className="h-4 w-4" />
          </Button>
        </div>

        {/* Stats */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="text-xs">
            {stats.total} total
          </Badge>
          {stats.withToolCalls > 0 && (
            <Badge variant="outline" className="text-xs flex items-center gap-1">
              <Hammer className="h-3 w-3" />
              {stats.withToolCalls} tools
            </Badge>
          )}
          {stats.completed > 0 && (
            <Badge variant="outline" className="text-xs flex items-center gap-1 text-green-600 border-green-200">
              <CheckCircle className="h-3 w-3" />
              {stats.completed} done
            </Badge>
          )}
          {stats.withErrors > 0 && (
            <Badge variant="destructive" className="text-xs flex items-center gap-1">
              <XCircle className="h-3 w-3" />
              {stats.withErrors} errors
            </Badge>
          )}
        </div>

        {/* Filters */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={filterType} onValueChange={(value) => setFilterType(value as FilterType)}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Events</SelectItem>
                <SelectItem value="tool-calls">Tool Calls</SelectItem>
                <SelectItem value="text">Text Responses</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="errors">Errors</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search traces..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 text-xs"
            />
          </div>

          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={expandAll} className="h-6 text-xs">
              Expand All
            </Button>
            <Button variant="ghost" size="sm" onClick={collapseAll} className="h-6 text-xs">
              Collapse All
            </Button>
          </div>
        </div>
      </div>

      {/* Event List */}
      <ScrollArea className="flex-1" ref={scrollAreaRef}>
        <div className="p-3 space-y-2">
          <AnimatePresence mode="popLayout">
            {filteredEvents.length === 0 ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-center text-muted-foreground py-8 text-sm"
              >
                {traceEvents.length === 0 
                  ? "No trace events yet"
                  : "No events match current filters"
                }
              </motion.div>
            ) : (
              filteredEvents.map((event) => (
                <TraceEventDisplay
                  key={event.id}
                  event={event}
                  isExpanded={expandedEvents.has(event.id)}
                  onToggleExpand={() => toggleEventExpanded(event.id)}
                />
              ))
            )}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}