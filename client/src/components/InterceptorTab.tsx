import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { Copy, Check, Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
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

const STORAGE_KEY = "mcpjam-interceptor-proxies";

export function InterceptorTab({
  connectedServerConfigs,
  selectedServer,
}: InterceptorTabProps) {
  const [serverProxies, setServerProxies] = useState<
    Record<string, ServerProxyState>
  >({});
  const eventSourceRefs = useRef<Record<string, EventSource>>({});
  const [isCreating, setIsCreating] = useState(false);

  // Get current server's proxy state
  const currentProxy =
    selectedServer && selectedServer !== "none"
      ? serverProxies[selectedServer]
      : null;

  // Save to localStorage whenever serverProxies changes
  const saveToStorage = (proxies: Record<string, ServerProxyState>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(proxies));
    } catch (e) {
      console.error("Failed to save proxy state to localStorage:", e);
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
          setServerProxies((prev) => {
            const newProxies = {
              ...prev,
              [serverId]: {
                ...prev[serverId],
                logs: [...(prev[serverId]?.logs || []), payload.log],
              },
            };
            saveToStorage(newProxies);
            return newProxies;
          });
        } else if (payload.type === "cleared") {
          setServerProxies((prev) => {
            const newProxies = {
              ...prev,
              [serverId]: {
                ...prev[serverId],
                logs: [],
              },
            };
            saveToStorage(newProxies);
            return newProxies;
          });
        }
      } catch (e) {
        console.error("Error parsing stream message:", e);
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

  // Load proxy state from localStorage on mount and validate against server
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return;
        const savedProxies = JSON.parse(saved) as Record<
          string,
          ServerProxyState
        >;

        const entries = Object.entries(savedProxies).filter(
          ([serverId]) =>
            connectedServerConfigs[serverId]?.connectionStatus === "connected",
        );

        const validated: Record<string, ServerProxyState> = {};
        await Promise.all(
          entries.map(async ([serverId, proxy]) => {
            try {
              const res = await fetch(`${baseUrl}/${proxy.interceptorId}`);
              if (!cancelled && res.ok) {
                validated[serverId] = proxy;
                connectStream(proxy.interceptorId, serverId);
              }
            } catch {}
          }),
        );

        if (!cancelled) {
          setServerProxies(validated);
          saveToStorage(validated);
        }
      } catch (e) {
        console.error("Failed to load proxy state from localStorage:", e);
      }
    })();

    return () => {
      cancelled = true;
      Object.values(eventSourceRefs.current).forEach((es) => es.close());
      eventSourceRefs.current = {};
    };
  }, [connectedServerConfigs, baseUrl]);

  // Clean up proxies when servers disconnect
  useEffect(() => {
    const disconnectedServers = Object.keys(serverProxies).filter(
      (serverId) => {
        const serverConfig = connectedServerConfigs[serverId];
        return !serverConfig || serverConfig.connectionStatus !== "connected";
      },
    );

    if (disconnectedServers.length > 0) {
      const newProxies = { ...serverProxies };
      let hasChanges = false;

      disconnectedServers.forEach((serverId) => {
        console.log(`Server ${serverId} disconnected, cleaning up proxy`);

        // Stop the proxy on server
        if (newProxies[serverId]?.interceptorId) {
          fetch(`${baseUrl}/${newProxies[serverId].interceptorId}`, {
            method: "DELETE",
          }).catch(() => {});
        }

        // Close event source
        if (eventSourceRefs.current[serverId]) {
          eventSourceRefs.current[serverId].close();
          delete eventSourceRefs.current[serverId];
        }

        // Remove from state
        delete newProxies[serverId];
        hasChanges = true;
      });

      if (hasChanges) {
        setServerProxies(newProxies);
        saveToStorage(newProxies);
      }
    }
  }, [connectedServerConfigs, serverProxies, baseUrl]);

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

    setIsCreating(true);
    try {
      const res = await fetch(`${baseUrl}/create`, {
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
      const proxy =
        (json.publicProxyUrl as string | undefined) ||
        (json.proxyUrl as string | undefined);

      const newProxies = {
        ...serverProxies,
        [serverId]: {
          interceptorId: id,
          proxyUrl: proxy || `${baseUrl}/${id}/proxy`,
          logs: [],
        },
      };

      setServerProxies(newProxies);
      saveToStorage(newProxies);
      connectStream(id, serverId);
    } catch (e) {
      console.error("Failed to create proxy:", e);
      alert("Failed to create interceptor");
    } finally {
      setIsCreating(false);
    }
  };

  const handleStop = async () => {
    if (!selectedServer || selectedServer === "none" || !currentProxy) return;
    // Stop and delete the interceptor on the server
    try {
      await fetch(`${baseUrl}/${currentProxy.interceptorId}`, {
        method: "DELETE",
      });
    } catch {}

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
      await fetch(`${baseUrl}/${currentProxy.interceptorId}/clear`, {
        method: "POST",
      });
    } catch {}

    // Clear logs in the UI
    const newProxies = {
      ...serverProxies,
      [selectedServer]: {
        ...serverProxies[selectedServer],
        logs: [],
      },
    };
    setServerProxies(newProxies);
    saveToStorage(newProxies);
  };

  const [copyConfigSuccess, setCopyConfigSuccess] = useState(false);

  // Copy handler for config entry overlay button is below

  const buildConfigSnippet = () => {
    const name =
      connectedServerConfigs[selectedServer]?.name ||
      selectedServer ||
      "server";
    const url = currentProxy?.proxyUrl || "";
    const lines = [
      `"${name}": {`,
      `  "type": "http",`,
      `  "url": "${url}",`,
      `  "headers": {}`,
      `}`,
    ];
    return lines.join("\n");
  };

  const buildConfigObject = () => {
    const name =
      connectedServerConfigs[selectedServer]?.name ||
      selectedServer ||
      "server";
    const url = currentProxy?.proxyUrl || "";
    return {
      [name]: {
        type: "http",
        url,
        headers: {},
      },
    } as Record<string, any>;
  };

  const handleCopyConfig = async () => {
    try {
      await navigator.clipboard.writeText(buildConfigSnippet());
      setCopyConfigSuccess(true);
      setTimeout(() => setCopyConfigSuccess(false), 1000);
    } catch (err) {
      console.error("Failed to copy config JSON:", err);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {/* Proxy Configuration */}
      <Card className="p-4">
        <h2 className="text-lg font-semibold mb-3">Proxy Configuration</h2>

        <div className="space-y-3">
          {currentProxy ? (
            <div className="p-3 rounded border">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium">
                    Active Proxy for{" "}
                    {connectedServerConfigs[selectedServer]?.name ||
                      selectedServer}
                  </div>
                  <span className="mr-1 inline-block size-1.5 rounded-full bg-orange-500" />
                </div>
                <div className="flex gap-2 ml-auto">
                  <Button variant="outline" size="sm" onClick={handleStop}>
                    Stop Proxy
                  </Button>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 items-start">
                <div className="text-sm text-muted-foreground leading-relaxed">
                  <div className="mb-2 font-medium text-foreground">
                    How this proxy works
                  </div>
                  <p>
                    This creates a HTTP proxy that forwards requests to your
                    connected MCP server. Add the JSON entry on the right in
                    your client’s configuration. Auth credentials are the same
                    as your server's and are injected automatically.
                  </p>
                </div>
                <div className="sm:col-start-2">
                  <label className="text-xs font-medium mb-1 block text-muted-foreground">
                    MCP HTTP config entry (no outer braces)
                  </label>
                  <div className="relative">
                    <pre className="block p-2 pr-10 bg-transparent border rounded text-xs whitespace-pre leading-relaxed font-mono">
                      {buildConfigSnippet()}
                    </pre>
                    <button
                      onClick={handleCopyConfig}
                      title="Copy config entry"
                      className={`absolute top-2 right-2 p-1 rounded transition-all duration-200 ${
                        copyConfigSuccess
                          ? "text-foreground scale-110"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      {copyConfigSuccess ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-muted rounded border">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium mb-1 truncate">
                    {selectedServer !== "none"
                      ? `Create proxy for ${connectedServerConfigs[selectedServer]?.name}`
                      : "No server selected"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedServer
                      ? "Create a local HTTP proxy URL to your connected server"
                      : "Select a server above to create a proxy"}
                  </div>
                </div>
                <div className="shrink-0 self-start sm:self-auto">
                  <Button
                    onClick={handleCreate}
                    disabled={
                      !selectedServer || selectedServer === "none" || isCreating
                    }
                  >
                    {isCreating ? (
                      <>
                        <Loader2 className="animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>Create Proxy</>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Logs */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Request Logs</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearLogs}
            disabled={!currentProxy}
          >
            Clear Logs
          </Button>
        </div>

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
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-mono ${
                        log.direction === "request"
                          ? "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300"
                          : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {log.direction}
                    </span>
                    {"method" in log ? (
                      <span className="font-mono">
                        <span className="font-semibold text-orange-600 dark:text-orange-400">
                          {log.method}
                        </span>
                        {(() => {
                          try {
                            const body = JSON.parse(log.body || "{}");
                            return body.method ? (
                              <span className="font-semibold text-foreground">
                                {" "}
                                {body.method}
                              </span>
                            ) : null;
                          } catch {
                            return null;
                          }
                        })()}
                      </span>
                    ) : (
                      <span className="font-mono font-semibold text-gray-600 dark:text-gray-400">
                        {log.status} {log.statusText}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground font-mono">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  {"url" in log && (
                    <div className="text-xs text-muted-foreground font-mono mb-1">
                      {log.url}
                    </div>
                  )}
                  {log.body &&
                    (() => {
                      let parsed: any = null;
                      try {
                        // Quick heuristic to avoid parsing non-JSON payloads
                        const t = log.body.trim();
                        if (t.startsWith("{") || t.startsWith("[")) {
                          parsed = JSON.parse(t);
                        }
                      } catch {}
                      if (parsed) {
                        return (
                          <div className="text-xs bg-background p-2 rounded border mt-1 overflow-auto">
                            <style>{`
                            /*
                             * react18-json-view uses CSS variables on the root
                             * element with class .json-view. We override them
                             * within this scoped container to match the MCP JAM
                             * orange + grey color scheme.
                             */
                            .json-viewer-mcpjam .json-view {
                              /* Keys/properties in orange */
                              --json-property: #E8622C; /* MCP JAM orange */
                              /* Everything else in muted grey */
                              --json-index: var(--muted-foreground);
                              --json-number: var(--muted-foreground);
                              --json-string: var(--muted-foreground);
                              --json-boolean: var(--muted-foreground);
                              --json-null: var(--muted-foreground);
                              color: var(--muted-foreground) !important;
                            }

                            /* Ensure dark mode also follows the same palette */
                            .dark .json-viewer-mcpjam .json-view {
                              --json-property: #FF6B35; /* slightly brighter orange on dark */
                              --json-index: var(--muted-foreground);
                              --json-number: var(--muted-foreground);
                              --json-string: var(--muted-foreground);
                              --json-boolean: var(--muted-foreground);
                              --json-null: var(--muted-foreground);
                              color: var(--muted-foreground) !important;
                            }
                          `}</style>
                            <div className="json-viewer-mcpjam">
                              <JsonView
                                src={parsed}
                                dark={false}
                                theme="default"
                                enableClipboard={true}
                                displaySize={true}
                                collapsed={2}
                                collapseStringsAfterLength={80}
                                collapseObjectsAfterLength={10}
                                style={{
                                  fontSize: "12px",
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                  backgroundColor: "hsl(var(--background))",
                                  padding: 0,
                                  borderRadius: 0,
                                  border: "none",
                                }}
                              />
                            </div>
                          </div>
                        );
                      }
                      return (
                        <pre className="text-xs bg-background p-2 rounded border mt-1 overflow-auto">
                          {log.body}
                        </pre>
                      );
                    })()}
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
