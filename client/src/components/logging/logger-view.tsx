import { useEffect, useRef, useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  Search,
  Trash2,
  Server,
  AppWindow,
} from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  useUiLogStore,
  type UiLogEvent,
  type UiProtocol,
} from "@/stores/ui-log-store";

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
}

function normalizePayload(
  payload: unknown,
): Record<string, unknown> | unknown[] {
  if (payload !== null && typeof payload === "object")
    return payload as Record<string, unknown>;
  return { value: payload } as Record<string, unknown>;
}

export function LoggerView({ serverIds }: LoggerViewProps = {}) {
  const [mcpServerItems, setMcpServerItems] = useState<RenderableRpcItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // Subscribe to UI log store for MCP Apps traffic
  const uiLogItems = useUiLogStore((s) => s.items);
  const clearUiLogs = useUiLogStore((s) => s.clear);

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

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearMessages = () => {
    setMcpServerItems([]);
    clearUiLogs();
    setExpanded(new Set());
  };

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      const params = new URLSearchParams();
      params.set("replay", "3");
      // Add timestamp to ensure fresh connection
      params.set("_t", Date.now().toString());
      es = new EventSource(`/api/mcp/servers/rpc/stream?${params.toString()}`);
      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as {
            type?: string;
          } & RpcEventMessage;
          if (!data || data.type !== "rpc") return;

          const { serverId, direction, message, timestamp } = data;
          const msg: any = message as any;
          const method: string =
            typeof msg?.method === "string"
              ? msg.method
              : msg?.result !== undefined
                ? "result"
                : msg?.error !== undefined
                  ? "error"
                  : "unknown";

          const item: RenderableRpcItem = {
            id: `${timestamp ?? Date.now()}-${Math.random().toString(36).slice(2)}`,
            serverId: typeof serverId === "string" ? serverId : "unknown",
            direction:
              typeof direction === "string" ? direction.toUpperCase() : "",
            method,
            timestamp: timestamp ?? new Date().toISOString(),
            payload: message,
            source: "mcp-server",
          };

          setMcpServerItems((prev) => [item, ...prev].slice(0, 1000));
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
  }, []); // Only run once on mount

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
  }, [allItems, searchQuery, serverIds]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-col gap-3 p-3 border-b border-border flex-shrink-0">
        <h2 className="text-xs font-semibold text-foreground">Logs</h2>
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
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {filteredItems.length} / {allItems.length}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearMessages}
            disabled={allItems.length === 0}
            className="h-7 px-2"
            title="Clear all messages"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3"
      >
        {filteredItems.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-xs text-muted-foreground">
              {"No logs yet"}
            </div>
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
              ? "border-l-2 border-l-purple-500/50"
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
                    {/* Source indicator */}
                    <span
                      className={`flex items-center justify-center p-0.5 rounded ${
                        isAppsTraffic
                          ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                          : "bg-slate-500/10 text-slate-600 dark:text-slate-400"
                      }`}
                      title={isAppsTraffic ? "Apps (UI)" : "MCP Server"}
                    >
                      {isAppsTraffic ? (
                        <AppWindow className="h-3 w-3" />
                      ) : (
                        <Server className="h-3 w-3" />
                      )}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {new Date(it.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="hidden sm:inline-block text-xs px-1.5 py-0.5 rounded bg-muted/50">
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
                    <span className="text-xs font-mono text-foreground truncate">
                      {it.method}
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
