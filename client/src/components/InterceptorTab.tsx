import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ServerWithName } from "@/hooks/use-app-state";

type InterceptorLog =
  | {
      id: string;
      timestamp: number;
      direction: "request";
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }
  | {
      id: string;
      timestamp: number;
      direction: "response";
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body?: string;
    };

type ServerProxyState = {
  interceptorId: string;
  proxyUrl: string;
  logs: InterceptorLog[];
};

type InterceptorTabProps = {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServer: string;
};

export function InterceptorTab({
  connectedServerConfigs,
  selectedServer,
}: InterceptorTabProps) {
  const [serverProxies, setServerProxies] = useState<Record<string, ServerProxyState>>({});
  const eventSourceRef = useRef<EventSource | null>(null);

  // Get current server's proxy state
  const currentProxy = selectedServer && selectedServer !== "none" ? serverProxies[selectedServer] : null;

  const baseUrl = useMemo(() => {
    const u = new URL(window.location.href);
    return `${u.origin}/api/mcp/interceptor`;
  }, []);

  const connectStream = (id: string, serverId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`${baseUrl}/${id}/stream`);
    es.onmessage = (ev) => {
      try {
        if (ev.data === "[DONE]") return;
        const payload = JSON.parse(ev.data);
        if (payload.type === "log" && payload.log) {
          setServerProxies(prev => ({
            ...prev,
            [serverId]: {
              ...prev[serverId],
              logs: [...(prev[serverId]?.logs || []), payload.log]
            }
          }));
        } else if (payload.type === "cleared") {
          setServerProxies(prev => ({
            ...prev,
            [serverId]: {
              ...prev[serverId],
              logs: []
            }
          }));
        }
      } catch {}
    };
    es.onerror = () => {
      // auto-reconnect with backoff not implemented for simplicity
    };
    eventSourceRef.current = es;
  };

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const handleCreate = async () => {
    // Only allow connected servers
    if (!selectedServer || selectedServer === "none") {
      alert("Please select a connected server");
      return;
    }

    const serverId = selectedServer;
    if (!connectedServerConfigs[serverId]) {
      alert("Selected server is not connected");
      return;
    }

    const res = await fetch(`${baseUrl}/create?tunnel=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId }),
    });
    const json = await res.json();
    if (!json.success) {
      alert(json.error || "Failed to create interceptor");
      return;
    }
    const id = json.id as string;
    const proxy = (json.publicProxyUrl as string | undefined) || (json.proxyUrl as string | undefined);

    setServerProxies(prev => ({
      ...prev,
      [serverId]: {
        interceptorId: id,
        proxyUrl: proxy || `${baseUrl}/${id}/proxy`,
        logs: []
      }
    }));

    connectStream(id, serverId);
  };

  const handleClear = async () => {
    if (!selectedServer || selectedServer === "none" || !currentProxy) return;

    await fetch(`${baseUrl}/${currentProxy.interceptorId}/clear`, { method: "POST" });

    setServerProxies(prev => {
      const newProxies = { ...prev };
      delete newProxies[selectedServer];
      return newProxies;
    });
  };

  return (
    <div className="p-4 space-y-4">
      {/* Proxy Configuration */}
      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-3">Proxy Configuration</h2>

        <div className="space-y-3">
          {currentProxy ? (
            <div className="p-3 bg-green-50 dark:bg-green-950/30 rounded border border-green-200 dark:border-green-800">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-sm font-medium text-green-800 dark:text-green-200">
                    Active Proxy for {connectedServerConfigs[selectedServer]?.name || selectedServer}
                  </div>
                  <div className="text-xs text-green-700 dark:text-green-300">
                    Proxy is running and ready to use
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={handleClear}>
                  Stop Proxy
                </Button>
              </div>
              <div>
                <label className="text-xs font-medium text-green-800 dark:text-green-200">Proxy URL</label>
                <code className="block mt-1 p-2 bg-white dark:bg-green-900/50 border rounded text-sm break-all">
                  {currentProxy.proxyUrl}
                </code>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-muted rounded border">
              <div className="text-sm font-medium mb-2">
                {selectedServer ? `Create proxy for ${connectedServerConfigs[selectedServer]?.name}` : "No server selected"}
              </div>
              <div className="text-xs text-muted-foreground mb-3">
                {selectedServer ? "This will create a proxy URL that tunnels requests to your connected server." : "Select a server above to create a proxy"}
              </div>
              <Button
                onClick={handleCreate}
                disabled={!selectedServer || selectedServer === "none"}
              >
                Create Proxy
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Logs */}
      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-3">Request Logs</h2>

        <div className="border rounded-md bg-muted/30 max-h-[60vh] overflow-auto">
          {!currentProxy?.logs || currentProxy.logs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No requests logged yet
            </div>
          ) : (
            <div className="divide-y">
              {currentProxy.logs.map((log) => (
                <div key={log.id} className="p-3 text-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-muted-foreground font-mono">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                      log.direction === "request" ? "bg-blue-100 text-blue-800" : "bg-green-100 text-green-800"
                    }`}>
                      {log.direction}
                    </span>
                    {"method" in log ? (
                      <span className="font-mono">{log.method}</span>
                    ) : (
                      <span className="font-mono">{log.status} {log.statusText}</span>
                    )}
                  </div>
                  {"url" in log && (
                    <div className="text-xs text-muted-foreground font-mono mb-1">{log.url}</div>
                  )}
                  {log.body && (
                    <pre className="text-xs bg-background p-2 rounded border mt-1 overflow-auto">
                      {log.body}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
