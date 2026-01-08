import { useEffect, useRef, useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Search,
  Trash2,
  PanelRightClose,
  Copy,
} from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useTrafficLogStore,
  subscribeToRpcStream,
  type UiLogEvent,
  type UiProtocol,
} from "@/stores/traffic-log-store";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import { setServerLoggingLevel } from "@/state/mcp-api";
import { toast } from "sonner";
import { useSharedAppState } from "@/state/app-state-context";
import type { ServerWithName } from "@/state/app-types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Filter, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

type RpcDirection = "in" | "out" | string;
type TrafficSource = "mcp-server" | "mcp-apps";

interface RpcEventMessage {
  serverId: string;
  direction: RpcDirection;
  message: unknown; // raw JSON-RPC payload (request/response/error)
  timestamp?: string;
}

interface RenderableRpcItem {
  id: string;
  serverId: string;
  direction: string;
  method: string;
  timestamp: string;
  payload: unknown;
  source: TrafficSource;
  protocol?: UiProtocol;
  widgetId?: string;
}

interface LoggerViewProps {
  serverIds?: string[]; // Optional filter for specific server IDs
  onClose?: () => void; // Optional callback to close/hide the panel
  isLogLevelVisible?: boolean;
  isCollapsable?: boolean;
  isSearchVisible?: boolean;
}

const LOGGING_LEVELS: LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

function normalizePayload(
  payload: unknown,
): Record<string, unknown> | unknown[] {
  if (payload !== null && typeof payload === "object")
    return payload as Record<string, unknown>;
  return { value: payload } as Record<string, unknown>;
}

export function LoggerView({
  serverIds,
  onClose,
  isLogLevelVisible = true,
  isCollapsable = true,
  isSearchVisible = true,
}: LoggerViewProps = {}) {
  const appState = useSharedAppState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [serverLogLevels, setServerLogLevels] = useState<
    Record<string, LoggingLevel>
  >({});
  const [sourceFilter, setSourceFilter] = useState<"all" | TrafficSource>(
    "all",
  );

  // Subscribe to UI log store (includes both MCP Apps and MCP Server RPC traffic)
  const uiLogItems = useTrafficLogStore((s) => s.items);
  const mcpServerRpcItems = useTrafficLogStore((s) => s.mcpServerItems);
  const clearLogs = useTrafficLogStore((s) => s.clear);

  // Convert UI log items to renderable format
  const mcpAppsItems = useMemo<RenderableRpcItem[]>(() => {
    return uiLogItems.map((item: UiLogEvent) => ({
      id: item.id,
      serverId: item.serverId,
      direction: item.direction === "ui-to-host" ? "UI→HOST" : "HOST→UI",
      method: item.method,
      timestamp: item.timestamp,
      payload: item.message,
      source: "mcp-apps" as TrafficSource,
      protocol: item.protocol,
      widgetId: item.widgetId,
    }));
  }, [uiLogItems]);

  // Convert MCP server RPC items to renderable format
  const mcpServerItems = useMemo<RenderableRpcItem[]>(() => {
    return mcpServerRpcItems.map((item) => ({
      id: item.id,
      serverId: item.serverId,
      direction: item.direction,
      method: item.method,
      timestamp: item.timestamp,
      payload: item.payload,
      source: "mcp-server" as TrafficSource,
    }));
  }, [mcpServerRpcItems]);

  const connectedServers = useMemo<
    Array<{ id: string; server: ServerWithName }>
  >(
    () =>
      Object.entries(appState.servers)
        .filter(([, server]) => server.connectionStatus === "connected")
        .map(([id, server]) => ({ id, server })),
    [appState.servers],
  );

  const selectableServers = useMemo(() => {
    if (!serverIds || serverIds.length === 0) return connectedServers;
    const filter = new Set(serverIds);
    return connectedServers.filter((server) => filter.has(server.id));
  }, [connectedServers, serverIds]);

  // Removed unused handleApplyLogLevel

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearMessages = () => {
    clearLogs();
    setExpanded(new Set());
  };

  const copyLogs = async () => {
    const logsText = filteredItems.map((item) => ({
      timestamp: item.timestamp,
      source: item.source,
      serverId: item.serverId,
      direction: item.direction,
      method: item.method,
      payload: item.payload,
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(logsText, null, 2));
      toast.success("Logs copied to clipboard");
    } catch {
      toast.error("Failed to copy logs");
    }
  };

  // Subscribe to the singleton SSE connection for RPC traffic
  useEffect(() => {
    const unsubscribe = subscribeToRpcStream();
    return unsubscribe;
  }, []);

  // Combine and sort all items by timestamp (newest first)
  const allItems = useMemo(() => {
    const combined = [...mcpServerItems, ...mcpAppsItems];
    return combined.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [mcpServerItems, mcpAppsItems]);

  const filteredItems = useMemo(() => {
    let result = allItems;

    // Filter by source type
    if (sourceFilter !== "all") {
      result = result.filter((item) => item.source === sourceFilter);
    }

    // Filter by serverIds if provided
    if (serverIds && serverIds.length > 0) {
      const serverIdSet = new Set(serverIds);
      result = result.filter((item) => serverIdSet.has(item.serverId));
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const queryLower = searchQuery.toLowerCase();
      result = result.filter((item) => {
        return (
          item.serverId.toLowerCase().includes(queryLower) ||
          item.method.toLowerCase().includes(queryLower) ||
          item.direction.toLowerCase().includes(queryLower) ||
          JSON.stringify(item.payload).toLowerCase().includes(queryLower)
        );
      });
    }

    return result;
  }, [allItems, searchQuery, serverIds, sourceFilter]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-col gap-2 p-3 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-foreground">Logs</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={copyLogs}
              disabled={filteredItems.length === 0}
              className="h-7 w-7"
              title="Copy logs to clipboard"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={clearMessages}
              disabled={allItems.length === 0}
              className="h-7 w-7"
              title="Clear all messages"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            {onClose && isCollapsable && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7"
                title="Hide JSON-RPC panel"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {isSearchVisible && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search logs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7 text-xs"
              />
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline-block">
              {filteredItems.length} / {allItems.length}
            </span>

            {/* Source Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 relative"
                  title="Filter Source"
                >
                  <Filter
                    className={cn(
                      "h-3.5 w-3.5",
                      sourceFilter !== "all" && "text-primary",
                    )}
                  />
                  {sourceFilter !== "all" && (
                    <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={sourceFilter}
                  onValueChange={(value) =>
                    setSourceFilter(value as "all" | TrafficSource)
                  }
                >
                  <DropdownMenuRadioItem value="all" className="text-xs">
                    All
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mcp-server" className="text-xs">
                    Server
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mcp-apps" className="text-xs">
                    Apps
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Log Level Config */}
            {isLogLevelVisible && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Log Levels"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-3" align="end">
                  <div className="space-y-3">
                    <h4 className="font-medium text-xs text-muted-foreground mb-2">
                      Server Log Levels
                    </h4>
                    {selectableServers.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground">
                        No connected servers
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectableServers.map((server) => (
                          <div
                            key={server.id}
                            className="flex items-center justify-between gap-2"
                          >
                            <span
                              className="text-[11px] font-medium truncate max-w-[120px]"
                              title={server.id}
                            >
                              {server.id}
                            </span>
                            <Select
                              value={serverLogLevels[server.id] || "debug"}
                              onValueChange={(val) => {
                                const level = val as LoggingLevel;
                                setServerLogLevels((prev) => ({
                                  ...prev,
                                  [server.id]: level,
                                }));
                                setServerLoggingLevel(server.id, level)
                                  .then((res) => {
                                    if (res?.success)
                                      toast.success(
                                        `Updated ${server.id} to ${level}`,
                                      );
                                    else
                                      toast.error(
                                        res?.error || "Failed to update",
                                      );
                                  })
                                  .catch(() => toast.error("Failed to update"));
                              }}
                            >
                              <SelectTrigger className="h-6 w-[100px] text-[10px]">
                                <SelectValue placeholder="Level" />
                              </SelectTrigger>
                              <SelectContent>
                                {LOGGING_LEVELS.map((level) => (
                                  <SelectItem
                                    key={level}
                                    value={level}
                                    className="text-[10px]"
                                  >
                                    {level}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3"
      >
        {filteredItems.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-xs text-muted-foreground">{"No logs yet"}</div>
            <div className="text-[10px] text-muted-foreground mt-1">
              {"Logs will appear here"}
            </div>
          </div>
        ) : (
          filteredItems.map((it) => {
            const isExpanded = expanded.has(it.id);
            const isAppsTraffic = it.source === "mcp-apps"; // Both MCP Apps and OpenAI Apps
            const isIncoming =
              it.direction === "RECEIVE" || it.direction === "UI→HOST";

            // Border color: purple for Apps traffic, none for MCP Server
            const borderClass = isAppsTraffic
              ? "border-l-4 border-l-purple-500/50"
              : "";

            return (
              <div
                key={it.id}
                className={`group border rounded-lg shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden bg-card ${borderClass}`}
              >
                <div
                  className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-muted/50 transition-colors"
                  onClick={() => toggleExpanded(it.id)}
                >
                  <div className="flex-shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3 text-muted-foreground transition-transform" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="hidden sm:inline-block text-xs px-1.5 py-0.5 rounded bg-muted/50 whitespace-nowrap">
                      {it.serverId}
                    </span>
                    {/* Direction indicator */}
                    <span
                      className={`flex items-center justify-center px-1 py-0.5 rounded ${
                        isIncoming
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "bg-green-500/10 text-green-600 dark:text-green-400"
                      }`}
                      title={it.direction}
                    >
                      {isIncoming ? (
                        <ArrowDownToLine className="h-3 w-3" />
                      ) : (
                        <ArrowUpFromLine className="h-3 w-3" />
                      )}
                    </span>
                    <span
                      className="text-xs font-mono text-foreground truncate"
                      title={it.method}
                    >
                      {it.method}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs whitespace-nowrap ml-auto">
                      {new Date(it.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t bg-muted/20">
                    <div className="p-3">
                      <div className="max-h-[40vh] overflow-auto rounded-sm bg-background/60 p-2">
                        <JsonView
                          src={normalizePayload(it.payload) as object}
                          dark={true}
                          theme="atom"
                          enableClipboard={true}
                          displaySize={false}
                          collapseStringsAfterLength={100}
                          style={{
                            fontSize: "11px",
                            fontFamily:
                              "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                            backgroundColor: "transparent",
                            padding: "0",
                            borderRadius: "0",
                            border: "none",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default LoggerView;
