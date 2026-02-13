import { useEffect, useRef, useState, useMemo } from "react";
import {
  ChevronRight,
  AlertCircle,
  Search,
  Trash2,
  PanelRightClose,
  Copy,
} from "lucide-react";
import { JsonEditor } from "@/components/ui/json-editor";
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

function DirectionLabel({
  direction,
  source,
}: {
  direction: string;
  source: TrafficSource;
}) {
  if (source === "mcp-apps") {
    const isHostToUi = direction === "HOST→UI";
    return (
      <span className="font-mono text-[10px] leading-none flex-shrink-0 text-purple-500">
        {isHostToUi ? "host → view" : "view → host"}
      </span>
    );
  }

  const isSend = direction === "SEND";
  return (
    <span
      className={cn(
        "font-mono text-[10px] leading-none flex-shrink-0",
        isSend
          ? "text-green-600 dark:text-green-400"
          : "text-blue-600 dark:text-blue-400",
      )}
    >
      {isSend ? "req →" : "← res"}
    </span>
  );
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
    const logs = filteredItems.map((item) => ({
      timestamp: item.timestamp,
      source: item.source,
      serverId: item.serverId,
      direction: item.direction,
      method: item.method,
      payload: item.payload,
    }));
    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
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

  const totalItemCount = allItems.length;
  const filteredItemCount = filteredItems.length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border flex-shrink-0">
        {isSearchVisible && (
          <>
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search logs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 pl-7 text-xs"
              />
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:inline-block">
              {filteredItemCount} / {totalItemCount}
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
          </>
        )}

        {/* Push action buttons to the right when search is hidden */}
        {!isSearchVisible && <div className="flex-1" />}

        <Button
          variant="ghost"
          size="icon"
          onClick={copyLogs}
          disabled={filteredItemCount === 0}
          className="h-7 w-7 flex-shrink-0"
          title="Copy logs to clipboard"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={clearMessages}
          disabled={totalItemCount === 0}
          className="h-7 w-7 flex-shrink-0"
          title="Clear all messages"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        {onClose && isCollapsable && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-7 w-7 flex-shrink-0"
            title="Hide JSON-RPC panel"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {filteredItemCount === 0 ? (
          <div className="text-center py-8">
            <div className="text-xs text-muted-foreground">{"No logs yet"}</div>
            <div className="text-[10px] text-muted-foreground mt-1">
              {"Logs will appear here"}
            </div>
          </div>
        ) : (
          <>
            {filteredItems.map((it) => {
              const isExpanded = expanded.has(it.id);
              const isAppsTraffic = it.source === "mcp-apps";

              const isError =
                it.method === "error" || it.method === "csp-violation";

              // Left border: 2px — red for errors, purple for Apps, transparent for MCP Server
              const borderClass = isError
                ? "border-l-destructive"
                : isAppsTraffic
                  ? "border-l-purple-500/50"
                  : "border-l-transparent";

              return (
                <div
                  key={it.id}
                  className={cn(
                    "border-b border-border border-l-2",
                    borderClass,
                    isError && "bg-destructive/5",
                    isExpanded && "bg-muted/20",
                  )}
                >
                  <div
                    className="h-7 px-2 flex items-center gap-1.5 cursor-pointer select-none hover:bg-muted/30 transition-colors"
                    onClick={() => toggleExpanded(it.id)}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150",
                        isExpanded && "rotate-90",
                      )}
                    />
                    {isError ? (
                      <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" />
                    ) : (
                      <DirectionLabel
                        direction={it.direction}
                        source={it.source}
                      />
                    )}
                    <span
                      className={cn(
                        "flex-1 min-w-0 font-mono text-xs truncate",
                        isError ? "text-destructive" : "text-foreground",
                      )}
                      title={it.method}
                    >
                      {it.method}
                    </span>
                    <span
                      className="hidden sm:inline text-muted-foreground truncate max-w-[120px] text-[11px]"
                      title={it.serverId}
                    >
                      {it.serverId}
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px] whitespace-nowrap tabular-nums">
                      {new Date(it.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-border bg-muted/10 p-2">
                      <div className="max-h-[40vh] overflow-auto">
                        <JsonEditor
                          height="100%"
                          value={normalizePayload(it.payload) as object}
                          readOnly
                          showToolbar={false}
                          collapsible
                          defaultExpandDepth={2}
                          collapseStringsAfterLength={100}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export default LoggerView;
