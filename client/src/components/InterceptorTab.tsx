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

const STORAGE_KEY = 'mcpjam-interceptor-proxies';

export function InterceptorTab({
  connectedServerConfigs,
  selectedServer,
}: InterceptorTabProps) {
  const [serverProxies, setServerProxies] = useState<Record<string, ServerProxyState>>({});
  const eventSourceRefs = useRef<Record<string, EventSource>>({});

  // Get current server's proxy state
  const currentProxy = selectedServer && selectedServer !== "none" ? serverProxies[selectedServer] : null;

  // Save to localStorage whenever serverProxies changes
  const saveToStorage = (proxies: Record<string, ServerProxyState>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(proxies));
    } catch (e) {
      console.error('Failed to save proxy state to localStorage:', e);
    }
  };

  const baseUrl = useMemo(() => {
    const u = new URL(window.location.href);
    return `${u.origin}/api/mcp/interceptor`;
  }, []);

  const connectStream = (id: string, serverId: string) => {
    // Close existing stream for this server if it exists
    if (eventSourceRefs.current[serverId]) {
      eventSourceRefs.current[serverId].close();
      delete eventSourceRefs.current[serverId];
    }

    const es = new EventSource(`${baseUrl}/${id}/stream`);
    es.onmessage = (ev) => {
      try {
        if (ev.data === "[DONE]") return;
        const payload = JSON.parse(ev.data);
        console.log(`Stream message for ${serverId}:`, payload);
        if (payload.type === "log" && payload.log) {
          setServerProxies(prev => {
            const newProxies = {
              ...prev,
              [serverId]: {
                ...prev[serverId],
                logs: [...(prev[serverId]?.logs || []), payload.log]
              }
            };
            saveToStorage(newProxies);
            return newProxies;
          });
        } else if (payload.type === "cleared") {
          setServerProxies(prev => {
            const newProxies = {
              ...prev,
              [serverId]: {
                ...prev[serverId],
                logs: []
              }
            };
            saveToStorage(newProxies);
            return newProxies;
          });
        }
      } catch (e) {
        console.error('Error parsing stream message:', e);
      }
    };
    es.onopen = () => {
      console.log(`Stream connected for ${serverId} interceptor:`, id);
    };
    es.onerror = (e) => {
      console.error(`Stream error for ${serverId}:`, e);
    };
    eventSourceRefs.current[serverId] = es;
  };

  // Load proxy state from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const savedProxies = JSON.parse(saved) as Record<string, ServerProxyState>;
        setServerProxies(savedProxies);

        // Reconnect streams for active proxies
        Object.entries(savedProxies).forEach(([serverId, proxy]) => {
          if (proxy.interceptorId && proxy.proxyUrl) {
            connectStream(proxy.interceptorId, serverId);
          }
        });
      }
    } catch (e) {
      console.error('Failed to load proxy state from localStorage:', e);
    }

    return () => {
      // Close all event sources on cleanup
      Object.values(eventSourceRefs.current).forEach(es => es.close());
      eventSourceRefs.current = {};
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

    const newProxies = {
      ...serverProxies,
      [serverId]: {
        interceptorId: id,
        proxyUrl: proxy || `${baseUrl}/${id}/proxy`,
        logs: []
      }
    };

    setServerProxies(newProxies);
    saveToStorage(newProxies);
    connectStream(id, serverId);
  };

  const handleStop = async () => {
    if (!selectedServer || selectedServer === "none" || !currentProxy) return;
    // Stop and delete the interceptor on the server
    try { await fetch(`${baseUrl}/${currentProxy.interceptorId}`, { method: "DELETE" }); } catch {}

    // Close the event source for this server
    if (eventSourceRefs.current[selectedServer]) {
      eventSourceRefs.current[selectedServer].close();
      delete eventSourceRefs.current[selectedServer];
    }

    const newProxies = { ...serverProxies };
    delete newProxies[selectedServer];
    setServerProxies(newProxies);
    saveToStorage(newProxies);
  };

  const handleClearLogs = async () => {
    if (!selectedServer || selectedServer === "none" || !currentProxy) return;

    try {
      await fetch(`${baseUrl}/${currentProxy.interceptorId}/clear`, { method: "POST" });
    } catch {}

    // Clear logs in the UI
    const newProxies = {
      ...serverProxies,
      [selectedServer]: {
        ...serverProxies[selectedServer],
        logs: []
      }
    };
    setServerProxies(newProxies);
    saveToStorage(newProxies);
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
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleClearLogs}>
                    Clear Logs
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleStop}>
                    Stop Proxy
                  </Button>
                </div>
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
