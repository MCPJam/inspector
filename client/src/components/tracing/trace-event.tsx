import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  ChevronDown, 
  ChevronRight, 
  Clock, 
  CheckCircle, 
  XCircle,
  Hammer,
  MessageSquare,
  List
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "@/lib/chat-utils";

interface TraceEvent {
  id: string;
  step: number;
  text?: string;
  toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
  toolResults?: Array<{ result: unknown; error?: string }>;
  timestamp: string;
}

interface TraceEventProps {
  event: TraceEvent;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

// JSON tree component for displaying parameters/results
function JsonTree({ data, depth = 0 }: { data: any; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);

  if (typeof data !== "object" || data === null) {
    return (
      <span
        className={cn(
          "text-xs",
          typeof data === "string" && "text-green-600/70 dark:text-green-400/70",
          typeof data === "number" && "text-blue-600/70 dark:text-blue-400/70",
          typeof data === "boolean" && "text-purple-600/70 dark:text-purple-400/70",
          data === null && "text-muted-foreground/60"
        )}
      >
        {typeof data === "string" ? `"${data}"` : String(data)}
      </span>
    );
  }

  const isArray = Array.isArray(data);
  const entries = isArray ? data.map((item, i) => [i, item]) : Object.entries(data);
  const bracketOpen = isArray ? "[" : "{";
  const bracketClose = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {bracketOpen}{bracketClose}
      </span>
    );
  }

  return (
    <div className="text-xs">
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
        <div className="ml-3 border-l border-border pl-2 space-y-1">
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
    </div>
  );
}

export function TraceEventDisplay({ event, isExpanded = false, onToggleExpand }: TraceEventProps) {
  const hasToolCalls = event.toolCalls && event.toolCalls.length > 0;
  const hasToolResults = event.toolResults && event.toolResults.length > 0;
  const hasText = event.text && event.text.trim();

  const getStepIcon = () => {
    if (hasToolResults) {
      const hasErrors = event.toolResults?.some(r => r.error);
      if (hasErrors) {
        return <XCircle className="h-4 w-4 text-red-600/70 dark:text-red-400/70" />;
      }
      return <CheckCircle className="h-4 w-4 text-green-600/70 dark:text-green-400/70" />;
    }
    if (hasToolCalls) {
      return <Clock className="h-4 w-4 text-blue-600/70 dark:text-blue-400/70 animate-pulse" />;
    }
    
    // Check if this is a tools/list event
    const eventLabel = getEventLabel();
    if (eventLabel === 'tools/list') {
      return <List className="h-4 w-4 text-blue-600/70 dark:text-blue-400/70" />;
    }
    
    return <MessageSquare className="h-4 w-4 text-muted-foreground" />;
  };

  const getEventLabel = () => {
    // If we have tool calls, use the first tool name as the primary label
    if (hasToolCalls && event.toolCalls && event.toolCalls.length > 0) {
      const primaryTool = event.toolCalls[0].name;
      if (event.toolCalls.length > 1) {
        return `${primaryTool} +${event.toolCalls.length - 1}`;
      }
      return primaryTool;
    }
    
    // If we have text response, try to infer the context from the content
    if (hasText && event.text) {
      const text = event.text.toLowerCase();
      
      // Check for common patterns that indicate tool-related responses
      if (text.includes('available tools') || text.includes('tools you can use')) {
        return 'tools/list';
      }
      if (text.includes('resources') && (text.includes('available') || text.includes('list'))) {
        return 'resources/list';
      }
      if (text.includes('prompts') && (text.includes('available') || text.includes('list'))) {
        return 'prompts/list';
      }
      
      // Generic response label for other text
      return 'response';
    }
    
    // Fallback to step number for edge cases
    return `Step ${event.step}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="border border-border/50 rounded-lg bg-background/50 overflow-hidden"
    >
      {/* Header */}
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {getStepIcon()}
          <div className="text-left">
            <div className="text-sm font-medium font-mono">
              {getEventLabel()}
              {hasToolCalls && event.toolCalls && event.toolCalls.length > 0 && (
                <span className="ml-2 text-xs text-muted-foreground font-sans">
                  {event.toolCalls.length} call{event.toolCalls.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatTimestamp(new Date(event.timestamp))}
            </div>
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
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t bg-background/30"
          >
            <div className="p-3 space-y-3">
              {/* Text content */}
              {hasText && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Response
                  </h4>
                  <div className="text-sm bg-muted/30 p-2 rounded border">
                    {event.text}
                  </div>
                </div>
              )}

              {/* Tool Calls */}
              {hasToolCalls && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2">
                    <Hammer className="h-3 w-3" />
                    Tool Calls ({event.toolCalls?.length})
                  </h4>
                  <div className="space-y-2">
                    {event.toolCalls?.map((toolCall, index) => (
                      <div key={index} className="bg-blue-50/30 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-800/50 rounded p-3">
                        <div className="font-mono text-sm font-medium text-blue-700 dark:text-blue-300 mb-2">
                          {toolCall.name}
                        </div>
                        {Object.keys(toolCall.params).length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted-foreground mb-1">Parameters:</div>
                            <JsonTree data={toolCall.params} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tool Results */}
              {hasToolResults && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Results ({event.toolResults?.length})
                  </h4>
                  <div className="space-y-2">
                    {event.toolResults?.map((result, index) => (
                      <div key={index} className={cn(
                        "border rounded p-3",
                        result.error 
                          ? "bg-red-50/30 dark:bg-red-950/20 border-red-200/50 dark:border-red-800/50"
                          : "bg-green-50/30 dark:bg-green-950/20 border-green-200/50 dark:border-green-800/50"
                      )}>
                        {result.error ? (
                          <div>
                            <div className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">Error:</div>
                            <div className="text-sm text-red-600 dark:text-red-400">{result.error}</div>
                          </div>
                        ) : (
                          <div>
                            <div className="text-xs font-medium text-green-700 dark:text-green-300 mb-1">Result:</div>
                            <JsonTree data={result.result} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}