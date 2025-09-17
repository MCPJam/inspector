import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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

type InterceptorTabProps = {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServer: string;
};

export function InterceptorTab({
  connectedServerConfigs,
  selectedServer,
}: InterceptorTabProps) {
  const [targetUrl, setTargetUrl] = useState<string>("");
  const [interceptorId, setInterceptorId] = useState<string>("");
  const [proxyUrl, setProxyUrl] = useState<string>("");
  const [logs, setLogs] = useState<InterceptorLog[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const baseUrl = useMemo(() => {
    const u = new URL(window.location.href);
    return `${u.origin}/api/mcp/interceptor`;
  }, []);

  const connectStream = (id: string) => {
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
          setLogs((prev) => [...prev, payload.log]);
        } else if (payload.type === "cleared") {
          setLogs([]);
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
    // Treat the sentinel 'none' as no selection
    const serverId = selectedServer && selectedServer !== "none" ? selectedServer : undefined;

    // Auto-detect target URL from selected server if not provided
    let finalTargetUrl = targetUrl;
    if (serverId && !targetUrl && connectedServerConfigs[serverId]) {
      const serverConfig = connectedServerConfigs[serverId].config;
      if (serverConfig.type === "http" && serverConfig.url) {
        finalTargetUrl = serverConfig.url;
        setTargetUrl(serverConfig.url); // Update UI to show the detected URL
      }
    }

    const res = await fetch(`${baseUrl}/create?tunnel=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Prefer server-side lookup by serverId to avoid exposing tokens
      body: JSON.stringify({ targetUrl: finalTargetUrl, serverId }),
    });
    const json = await res.json();
    if (!json.success) {
      alert(json.error || "Failed to create interceptor");
      return;
    }
    const id = json.id as string;
    setInterceptorId(id);
    const proxy = (json.publicProxyUrl as string | undefined) || (json.proxyUrl as string | undefined);
    setProxyUrl(proxy || `${baseUrl}/${id}/proxy`);
    connectStream(id);
  };

  const handleClear = async () => {
    if (!interceptorId) return;
    await fetch(`${baseUrl}/${interceptorId}/clear`, { method: "POST" });
    setLogs([]);
  };

  return (
    <div className="p-4 flex flex-col gap-4">
      <Card className="p-4 flex flex-col gap-4">
        <div className="text-sm text-muted-foreground">
          Create an interceptor that proxies MCP HTTP JSON-RPC requests and logs all traffic. Choose between two modes:
        </div>

        <div className="space-y-3">
          <div className="p-3 border rounded-md bg-muted/30">
            <h3 className="text-sm font-medium mb-2">🔗 Connected Server Mode</h3>
            <p className="text-xs text-muted-foreground mb-2">
              Tunnel through a server you've already connected to in the inspector. Reuses OAuth and existing connections.
            </p>
            <p className="text-xs text-muted-foreground">
              {selectedServer && selectedServer !== "none"
                ? `Using selected server: ${selectedServer}`
                : "No server selected. Use the server selector above to choose a connected server."}
            </p>
          </div>

          <div className="p-3 border rounded-md bg-muted/30">
            <h3 className="text-sm font-medium mb-2">🌐 External Server Mode</h3>
            <p className="text-xs text-muted-foreground mb-2">
              Direct proxy to any external MCP HTTP server URL.
            </p>
            <Input
              placeholder="MCP HTTP URL (e.g., https://example.com/mcp)"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button onClick={handleCreate} disabled={!targetUrl && (!selectedServer || selectedServer === "none")}>
            Create Interceptor
          </Button>
          <Button variant="secondary" onClick={handleClear} disabled={!interceptorId}>
            Clear Logs
          </Button>
        </div>

        {proxyUrl && (
          <div className="p-3 border rounded-md bg-green-50 dark:bg-green-950/30">
            <h4 className="text-sm font-medium text-green-800 dark:text-green-200 mb-1">✅ Proxy Ready</h4>
            <p className="text-xs text-green-700 dark:text-green-300 mb-2">
              Add this URL as your MCP server in Claude Desktop, Cursor, or any MCP client:
            </p>
            <code className="text-xs bg-green-100 dark:bg-green-900/50 p-2 rounded block break-all">
              {proxyUrl}
            </code>
          </div>
        )}
      </Card>

      <Card className="p-2">
        <div className="max-h-[60vh] overflow-auto text-xs font-mono">
          {logs.map((log) => (
            <div key={log.id} className="border-b px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="uppercase text-[10px] px-1 rounded bg-muted">
                  {log.direction}
                </span>
                {"method" in log ? (
                  <span>{log.method}</span>
                ) : (
                  <span>
                    {log.status} {log.statusText}
                  </span>
                )}
              </div>
              {"url" in log && (
                <div className="text-muted-foreground truncate">{log.url}</div>
              )}
              {log.body && (
                <pre className="mt-1 whitespace-pre-wrap break-words">{log.body}</pre>
              )}
            </div>
          ))}
          {logs.length === 0 && (
            <div className="p-4 text-muted-foreground">No logs yet.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
