import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card } from "./ui/card";
import { ActiveServerSelector } from "./ActiveServerSelector";
import { ServerWithName } from "@/hooks/use-app-state";
import { ServerFormData } from "@/shared/types.js";

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
  selectedMultipleServers: string[];
  onServerChange: (server: string) => void;
  onMultiServerToggle: (server: string) => void;
  onConnect: (formData: ServerFormData) => void;
};

export function InterceptorTab({
  connectedServerConfigs,
  selectedServer,
  selectedMultipleServers,
  onServerChange,
  onMultiServerToggle,
  onConnect,
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
    const managerId = selectedServer && selectedServer !== "none" ? selectedServer : undefined;
    const res = await fetch(`${baseUrl}/create?tunnel=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUrl, managerServerId: managerId }),
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
      <Card className="p-4 flex flex-col gap-2">
        <div className="text-sm text-muted-foreground">
          Create an interceptor that proxies MCP HTTP JSON-RPC and streams logs.
        </div>
        <ActiveServerSelector
          connectedServerConfigs={connectedServerConfigs}
          selectedServer={selectedServer}
          selectedMultipleServers={selectedMultipleServers}
          isMultiSelectEnabled={false}
          onServerChange={onServerChange}
          onMultiServerToggle={onMultiServerToggle}
          onConnect={onConnect}
        />
        <div className="flex gap-2">
          {/* In manager-backed mode, target URL is not required; keeping the field for raw HTTP targets */}
          <Input placeholder="Target MCP HTTP URL (optional when tunneling an active server)" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
          <Button onClick={handleCreate} disabled={!targetUrl && !selectedServer}>
            Create Interceptor
          </Button>
          <Button variant="secondary" onClick={handleClear} disabled={!interceptorId}>
            Clear Logs
          </Button>
        </div>
        {proxyUrl && (
          <div className="text-xs">
            Add this as the MCP server URL in your client to route via proxy: <span className="font-mono break-all">{proxyUrl}</span>
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

